import type { Agent, AgentHandle, AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { KernelBinding } from '../../shared/types'
import type { NativeSession, NativeSessionOpenOptions, NativeSink } from '../backends/types'
import type { HostContext, NativeEntry, NativeExecution } from '../types'
import type { OfficialSink } from './sink.types'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, resolveUngroupedSessionPath } from 'dsh-tauri'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { BRIDGE_PROVIDER, KERNEL_RECORD_TYPE } from '../config/constants'
import { resetRuntime, runtime } from '../config/runtime'
import { server } from '../server'
import { waitFor } from '../utils/abort'
import { backend } from './backend'
import { checkpoint } from './checkpoint'
import { identity } from './identity'
import { sink } from './sink'

export const session = defineService({
  async create(id: KernelBinding['backend'], workspaceId?: string, directory?: string, agentPreset?: string): Promise<{ sessionId: string }> {
    const ctx = getServerContext<HostContext>(server)
    const lifetime = runtime.lifetime
    if (!runtime.ready)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: 原生桥接尚未就绪。')
    if (workspaceId !== undefined && directory !== undefined)
      throw new Error('BRIDGE_LOCATION_CONFLICT: 不能同时指定工作区与目录。')
    const resolved = await backend.resolve(id)
    if (!resolved.detection.installed || !resolved.command || resolved.detection.auth === 'missing')
      throw new Error(resolved.detection.hint ?? 'BRIDGE_BACKEND_UNAVAILABLE: 本机内核不可用。')
    const workspace = workspaceId === undefined ? undefined : ctx.workspaceRegistry.get(workspaceId as WorkspaceId)
    if (workspaceId !== undefined && !workspace)
      throw new Error('BRIDGE_WORKSPACE_NOT_FOUND: 工作区不存在。')
    let cwd = workspace?.path ?? directory
    if (cwd === undefined) {
      cwd = resolveUngroupedSessionPath()
      await mkdir(cwd, { recursive: true })
    }
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error('BRIDGE_CWD_INVALID: 会话目录必须是已存在的绝对目录。')
    cwd = await realpath(cwd)
    lifetime.signal.throwIfAborted()
    const preset = await ctx.agentPresets.resolve(agentPreset)
    lifetime.signal.throwIfAborted()
    if (preset.broken)
      throw new Error(`BRIDGE_PRESET_UNAVAILABLE: ${preset.broken}`)
    const sessionId = `session-${randomUUID()}` as SessionId
    let handle: AgentHandle | undefined
    try {
      handle = await ctx.agents.withoutInitiator(() => ctx.agents.create({
        sessionId,
        agentOptions: { provider: BRIDGE_PROVIDER, model: id },
        meta: { cwd, agentPreset: preset.id },
        signal: lifetime.signal,
        async setup(agentCtx, agent) {
          const startup = new AbortController()
          agentCtx.effect(() => async () => {
            startup.abort(new Error('BRIDGE_SETUP_CLOSED'))
            await session.remove(agent.id, agent)
          }, 'bridge native session setup')
          const signal = AbortSignal.any([startup.signal, lifetime.signal])
          signal.throwIfAborted()
          await ctx.agentPresets.mount(agentCtx, preset.id)
          signal.throwIfAborted()
          agentCtx.fiber.assertActive()
          session.validateComposition(agent)
          const entry = await open(agent, id, null, signal)
          signal.throwIfAborted()
          agentCtx.fiber.assertActive()
          await identity.append(agent, entry.binding)
          signal.throwIfAborted()
          agentCtx.fiber.assertActive()
          return {
            commit(): void {
              signal.throwIfAborted()
              agentCtx.fiber.assertActive()
              if (runtime.lifetime !== lifetime || !runtime.ready || !sameBinding(identity.resolve(agent), entry.binding) || agent.options.provider !== BRIDGE_PROVIDER || agent.options.model !== id)
                throw new Error('BRIDGE_BINDING_NOT_COMMITTED: 原生身份未写入官方投影。')
            },
          }
        },
      }))
      runtime.lifetime.signal.throwIfAborted()
      if (workspace)
        await workspace.attachSession(sessionId)
      runtime.lifetime.signal.throwIfAborted()
      if (ctx.agents.get(sessionId) !== handle.agent || ctx.sessions.get(sessionId) !== handle.agent.session)
        throw new Error('BRIDGE_AGENT_REPLACED: 新会话已关闭或被替换。')
      return { sessionId }
    }
    catch (error) {
      const outcomes = await Promise.allSettled([handle?.dispose(), session.remove(sessionId)])
      const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0)
        throw new AggregateError([error, ...failures.map(result => result.reason)], 'BRIDGE_CREATION_ROLLBACK_FAILED')
      throw error
    }
  },

  async createInherited(source: Session, create: (signal?: AbortSignal) => Promise<AgentHandle>): Promise<AgentHandle> {
    const ctx = getServerContext<HostContext>(server)
    const state = ctx.sessionProjections.stateOf(source, 'bridgeKernel')
    if (state?.binding === null || state?.binding === undefined) {
      if ((state?.inheritedBinding !== null && state?.inheritedBinding !== undefined) || source.requestHeader()?.config.provider === BRIDGE_PROVIDER)
        throw new Error('BRIDGE_BINDING_MISSING: 源会话尚未完成原生绑定，不能派生工作树会话。')
      return create()
    }
    const lifetime = runtime.lifetime
    const parent = await resolveParent(source.id, lifetime.signal)
    await waitFor(parent.whenIdle(), lifetime.signal)
    lifetime.signal.throwIfAborted()
    if (parent.session !== source)
      throw new Error('BRIDGE_FORK_SOURCE_CHANGED: 源会话实例已被替换，请重新创建工作树会话。')
    return parent.runMaintenance(async (signal) => {
      signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
      if (runtime.lifetime !== lifetime)
        throw new Error('BRIDGE_DISPOSED: 原生派生的桥接生命周期已结束。')
      const cursor = source.seq
      const handle = await create(AbortSignal.any([signal, lifetime.signal]))
      try {
        signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        if (runtime.lifetime !== lifetime || source.seq !== cursor || ctx.agents.get(source.id) !== parent)
          throw new Error('BRIDGE_FORK_SOURCE_CHANGED: 源会话在原生派生期间发生变化。')
        return handle
      }
      catch (error) {
        await handle.dispose()
        throw error
      }
    })
  },

  async prepare(source: Session, agent: Agent, signal: AbortSignal): Promise<AgentSetupCommit | void> {
    const ctx = getServerContext<HostContext>(server)
    const state = ctx.sessionProjections.stateOf(source, 'bridgeKernel')
    const binding = state?.binding
    if (binding === null || binding === undefined) {
      if ((state?.inheritedBinding !== null && state?.inheritedBinding !== undefined) || source.requestHeader()?.config.provider === BRIDGE_PROVIDER)
        throw new Error('BRIDGE_BINDING_MISSING: 源会话尚未完成原生绑定，不能派生工作树会话。')
      return
    }
    if (binding.sessionId !== source.id || agent.session.header.parentSession !== source.id || !agent.session.header.isSeeded)
      throw new Error('BRIDGE_FORK_INVALID: 原生派生必须来自当前官方父会话。')
    const inherited = identity.inherited(agent.session)
    if (!inherited || !sameBinding(inherited, binding))
      throw new Error('BRIDGE_FORK_INVALID: 原生派生与官方继承前缀不一致。')
    return bindFork(agent, binding, signal, source)
  },

  async repairInherited(agent: Agent, signal: AbortSignal): Promise<void> {
    const ctx = getServerContext<HostContext>(server)
    const state = ctx.sessionProjections.stateOf(agent.session, 'bridgeKernel')
    const scoped = AbortSignal.any([signal, runtime.lifetime.signal])
    if (state?.binding !== null && state?.binding !== undefined)
      return
    const inherited = identity.inherited(agent.session)
    if (!inherited)
      return
    const parent = await resolveParent(inherited.sessionId, scoped)
    await waitFor(parent.whenIdle(), scoped)
    const cursor = agent.session.inheritedEventCount
    await waitFor(parent.runMaintenance(async (maintenance) => {
      const repairing = AbortSignal.any([scoped, maintenance])
      if (parent.session.seq !== cursor)
        throw new Error('BRIDGE_FORK_SOURCE_CHANGED: 父会话已改变，不能将较新的原生历史替代继承前缀。')
      const commit = await bindFork(agent, inherited, repairing, parent.session)
      commit.commit()
      await checkpoint.flush(agent, repairing)
      repairing.throwIfAborted()
      if (parent.session.seq !== cursor)
        throw new Error('BRIDGE_FORK_SOURCE_CHANGED: 父会话在原生派生期间发生变化。')
    }), scoped)
    signal.throwIfAborted()
    if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session)
      throw new Error('BRIDGE_AGENT_REPLACED: 工作树会话已关闭或被替换。')
  },

  async connect(agent: Agent, signal: AbortSignal): Promise<NativeSession> {
    const binding = identity.resolve(agent)
    try {
      const entry = await open(agent, binding.backend, binding.nativeSessionId, signal)
      return entry.session
    }
    catch (error) {
      if (/BRIDGE_NATIVE_TURN|No conversation found/.test(error instanceof Error ? error.message : String(error)))
        throw new Error('BRIDGE_SESSION_UNRECOVERABLE: 原生会话记录已不存在，请新建会话。')
      throw error
    }
  },

  validateComposition(agent: Agent): void {
    const ctx = getServerContext<HostContext>(server)
    if (typeof ctx.agentPresets.inspectCompositions !== 'function')
      return
    for (const composition of ctx.agentPresets.inspectCompositions(agent.ctx)) {
      if (composition.modules.some(module => module.moduleName === '@deepseek-ai/dsh-hooks-codex' || module.moduleName === '@deepseek-ai/dsh-hooks-claude-code'))
        throw new Error('BRIDGE_HOOK_COMPOSITION_UNSUPPORTED: 原生会话不能叠加官方 Codex / Claude hooks，避免重复执行本机配置。')
    }
  },

  async execute(input: NativeExecution): Promise<OfficialSink> {
    const ctx = getServerContext<HostContext>(server)
    if (input.binding.sessionId !== input.agent.session.id || !sameBinding(ctx.sessionProjections.stateOf(input.agent.session, 'bridgeKernel')?.binding, input.binding))
      throw new Error('BRIDGE_BINDING_MISMATCH: 不能替换已有会话的原生内核。')
    input.signal.throwIfAborted()
    const current = runtime.exchanges.get(input.agent.id)
    if (current) {
      const state = current.state
      if (state.input.agent !== input.agent || state.input.turn !== input.turn || state.input.signal !== input.signal || input.step <= state.lastStep || !sameBinding(state.input.binding, input.binding) || state.finalConsumed)
        throw new Error('BRIDGE_TURN_MISMATCH: 原生回合不能重试、替换或跨回合复用。')
      for (const tool of state.tools.values()) {
        if (tool.step !== undefined && tool.step <= state.lastStep && !tool.committed)
          throw new Error('BRIDGE_TOOL_RESULT_REJECTED: 官方工具结果尚未完整提交。')
      }
      state.signal.throwIfAborted()
      if (state.failure !== undefined)
        throw state.failure
      state.lastStep = input.step
      return current
    }
    const official = await sink.create(input)
    const state = official.state
    runtime.sinks.set(input.agent.id, state.native)
    state.task = (async () => {
      try {
        const entry = await open(input.agent, input.binding.backend, input.binding.nativeSessionId, state.signal)
        state.signal.throwIfAborted()
        if (!sameBinding(entry.binding, input.binding))
          throw new Error('BRIDGE_RESUME_MISMATCH: 原生内核未恢复已绑定的会话。')
        await entry.session.submit(input.messages, state.signal, input.options)
        official.settle()
      }
      catch (error) {
        official.settle(error)
      }
      finally {
        if (runtime.sinks.get(input.agent.id) === state.native)
          runtime.sinks.delete(input.agent.id)
      }
    })()
    return official
  },

  async finish(agent: Agent, turn: number): Promise<void> {
    const official = runtime.exchanges.get(agent.id)
    if (!official || official.state.input.agent !== agent || official.state.input.turn !== turn)
      return
    const previous = runtime.closings.get(agent.id)
    if (previous)
      return previous
    const task = drainTurn(official)
    runtime.closings.set(agent.id, task)
    try {
      await task
    }
    finally {
      if (runtime.closings.get(agent.id) === task)
        runtime.closings.delete(agent.id)
    }
  },

  async remove(sessionId: string, owner?: Agent): Promise<void> {
    if (owner !== undefined && !ownsSession(sessionId, owner))
      return
    const previous = runtime.removals.get(sessionId)
    if (previous)
      return previous
    const task = close(sessionId, owner)
    runtime.removals.set(sessionId, task)
    try {
      await task
    }
    finally {
      if (runtime.removals.get(sessionId) === task)
        runtime.removals.delete(sessionId)
    }
  },

  async dispose(): Promise<void> {
    runtime.lifetime.abort(new Error('BRIDGE_DISPOSED'))
    const agents = new Set([...runtime.sessions.values()].map(entry => entry.agent))
    for (const step of runtime.steps.values())
      agents.add(step.agent)
    for (const agent of agents)
      agent.cancel({ kind: 'disposed' })
    const idle = await Promise.allSettled([...agents].map(agent => agent.whenIdle()))
    await resetRuntime()
    const failures = idle.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0)
      throw new AggregateError(failures.map(result => result.reason), 'BRIDGE_IDLE_FAILED')
  },
})

async function drainTurn(official: OfficialSink): Promise<void> {
  const state = official.state
  const complete = state.done && state.finalConsumed && !state.signal.aborted && state.failure === undefined && [...state.tools.values()].every(tool => tool.committed)
  if (!complete)
    state.controller.abort(state.failure ?? new Error('BRIDGE_PREMATURE_TURN_END: 官方回合提前结束，已停止原生内核。'))
  try {
    await state.task
    if (!complete)
      throw state.failure ?? state.signal.reason ?? new Error('BRIDGE_PREMATURE_TURN_END')
  }
  finally {
    try {
      if (!complete)
        await session.remove(state.input.agent.id, state.input.agent)
    }
    finally {
      await official.dispose()
    }
  }
}

async function bindFork(agent: Agent, source: KernelBinding, signal: AbortSignal, parent: Session): Promise<AgentSetupCommit> {
  const lifetime = runtime.lifetime
  const startup = new AbortController()
  agent.ctx.effect(() => async () => {
    startup.abort(new Error('BRIDGE_SETUP_CLOSED'))
    await session.remove(agent.id, agent)
  }, 'bridge native fork setup')
  const scoped = AbortSignal.any([signal, startup.signal, lifetime.signal])
  const ctx = getServerContext<HostContext>(server)
  try {
    scoped.throwIfAborted()
    agent.ctx.fiber.assertActive()
    session.validateComposition(agent)
    assertForkSource(parent, agent, source)
    const hasConversation = parent.deriveMessages().some(message => message.role === 'assistant' || message.role === 'tool' || (message.role === 'user' && message.source.kind === 'user'))
    const entry = await open(agent, source.backend, null, scoped, hasConversation ? { forkFrom: source.nativeSessionId } : undefined)
    assertForkSource(parent, agent, source)
    scoped.throwIfAborted()
    agent.ctx.fiber.assertActive()
    if (entry.binding.nativeSessionId === source.nativeSessionId)
      throw new Error('BRIDGE_FORK_MISMATCH: 工作树必须获得独立的原生会话身份。')
    const seq = await identity.append(agent, entry.binding)
    if (agent.options.provider === undefined && agent.options.model === undefined)
      identity.hydrate(agent)
    if (ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.id) === agent.session)
      checkpoint.mark(agent, KERNEL_RECORD_TYPE, seq, entry.binding)
    scoped.throwIfAborted()
    agent.ctx.fiber.assertActive()
    return {
      commit(): void {
        scoped.throwIfAborted()
        agent.ctx.fiber.assertActive()
        assertForkSource(parent, agent, source)
        if (runtime.lifetime !== lifetime || !runtime.ready || !sameBinding(identity.resolve(agent), entry.binding) || ctx.sessionProjections.stateOf(agent.session, 'bridgeKernel')?.inheritedBinding?.sessionId !== agent.session.header.parentSession)
          throw new Error('BRIDGE_BINDING_NOT_COMMITTED: 工作树原生身份未写入官方投影。')
      },
    }
  }
  catch (error) {
    await session.remove(agent.id, agent)
    throw error
  }
}

async function resolveParent(sessionId: string, signal: AbortSignal): Promise<Agent> {
  const ctx = getServerContext<HostContext>(server)
  runtime.lifetime.signal.throwIfAborted()
  const live = ctx.agents.get(sessionId as SessionId)
  if (live)
    return live
  const controller = ctx.get('sessionController')
  if (typeof controller?.resolveAgent !== 'function')
    throw new Error('BRIDGE_FORK_SOURCE_UNAVAILABLE: 无法读取原生派生的官方父会话。')
  const result = await waitFor<Awaited<ReturnType<HostContext['sessionController']['resolveAgent']>>>(controller.resolveAgent(sessionId as SessionId), signal)
  signal.throwIfAborted()
  if ('error' in result)
    throw result.error
  runtime.lifetime.signal.throwIfAborted()
  if (!result.agent)
    throw new Error('BRIDGE_FORK_SOURCE_UNAVAILABLE: 官方父会话无法恢复。')
  return result.agent
}

function assertForkSource(parent: Session, child: Agent, binding: KernelBinding): void {
  const ctx = getServerContext<HostContext>(server)
  if (parent.id !== child.session.header.parentSession || parent.seq !== child.session.inheritedEventCount || !sameBinding(ctx.sessionProjections.stateOf(parent, 'bridgeKernel')?.binding, binding))
    throw new Error('BRIDGE_FORK_SOURCE_CHANGED: 父会话与当前继承前缀不一致，请重新创建工作树会话。')
}

async function close(sessionId: string, owner?: Agent): Promise<void> {
  if (owner !== undefined && !ownsSession(sessionId, owner))
    return
  const controller = runtime.controllers.get(sessionId)
  controller?.abort(new Error('BRIDGE_SESSION_DISPOSED'))
  const pending = runtime.pending.get(sessionId)
  if (pending)
    await pending.task.catch(() => undefined)
  const entry = runtime.sessions.get(sessionId)
  if (entry) {
    await entry.session.dispose()
    if (runtime.sessions.get(sessionId) === entry)
      runtime.sessions.delete(sessionId)
    if (runtime.claims.get(keyOf(entry.binding)) === sessionId)
      runtime.claims.delete(keyOf(entry.binding))
  }
  if (runtime.controllers.get(sessionId) === controller)
    runtime.controllers.delete(sessionId)
}

async function open(agent: Agent, id: KernelBinding['backend'], storedId: string | null, signal: AbortSignal, options?: NativeSessionOpenOptions): Promise<NativeEntry> {
  signal.throwIfAborted()
  runtime.lifetime.signal.throwIfAborted()
  if (runtime.removals.has(agent.id))
    throw new Error('BRIDGE_SESSION_CLOSING: 原生会话正在关闭。')
  const current = runtime.sessions.get(agent.id)
  if (current) {
    if (current.agent !== agent || current.binding.backend !== id || (storedId !== null && current.binding.nativeSessionId !== storedId))
      throw new Error('BRIDGE_NATIVE_OWNER_CONFLICT: 原生会话已有其它所有者。')
    return current
  }
  const pending = runtime.pending.get(agent.id)
  if (pending) {
    if (pending.agent !== agent)
      throw new Error('BRIDGE_NATIVE_OWNER_CONFLICT: 待连接的原生会话属于其它所有者。')
    const entry = await pending.task
    signal.throwIfAborted()
    if (entry.agent !== agent || entry.binding.backend !== id || (storedId !== null && entry.binding.nativeSessionId !== storedId))
      throw new Error('BRIDGE_NATIVE_OWNER_CONFLICT: 待连接的原生会话属于其它所有者。')
    return entry
  }
  const controller = new AbortController()
  runtime.controllers.set(agent.id, controller)
  const task = connect(agent, id, storedId, controller, AbortSignal.any([runtime.lifetime.signal, controller.signal, signal]), options)
  const opening = { agent, controller, task }
  runtime.pending.set(agent.id, opening)
  try {
    return await task
  }
  finally {
    if (runtime.pending.get(agent.id) === opening)
      runtime.pending.delete(agent.id)
    if (!runtime.sessions.has(agent.id) && runtime.controllers.get(agent.id) === controller)
      runtime.controllers.delete(agent.id)
  }
}

async function connect(agent: Agent, id: KernelBinding['backend'], storedId: string | null, controller: AbortController, signal: AbortSignal, options?: NativeSessionOpenOptions): Promise<NativeEntry> {
  const resolved = await backend.resolve(id)
  signal.throwIfAborted()
  if (!resolved.detection.installed || !resolved.command || resolved.detection.auth === 'missing')
    throw new Error(resolved.detection.hint ?? 'BRIDGE_BACKEND_UNAVAILABLE: 本机内核不可用。')
  const nativeSink: NativeSink = {
    text: (...args) => activeSink(agent, controller).text(...args),
    thinking: (...args) => activeSink(agent, controller).thinking(...args),
    assistant: (...args) => activeSink(agent, controller).assistant(...args),
    toolStart: (...args) => activeSink(agent, controller).toolStart(...args),
    toolEnd: (...args) => activeSink(agent, controller).toolEnd(...args),
    approval: (...args) => activeSink(agent, controller).approval(...args),
    questions: (...args) => activeSink(agent, controller).questions(...args),
  }
  const factory = id === 'codex' ? createCodexSession : createClaudeSession
  const native = await factory(resolved.command, agent.session.header.cwd!, storedId, nativeSink, signal, options)
  try {
    signal.throwIfAborted()
    if (!native.id || (storedId !== null && storedId !== native.id))
      throw new Error('BRIDGE_RESUME_MISMATCH: 原生内核返回了不同的会话身份。')
    const binding: KernelBinding = { backend: id, nativeSessionId: native.id, sessionId: agent.session.id }
    const owner = runtime.claims.get(keyOf(binding))
    if (owner !== undefined && owner !== agent.id)
      throw new Error('BRIDGE_NATIVE_OWNER_CONFLICT: 原生会话已绑定其它官方会话。')
    const entry = { agent, binding, session: native, controller }
    runtime.claims.set(keyOf(binding), agent.id)
    runtime.sessions.set(agent.id, entry)
    return entry
  }
  catch (error) {
    await native.dispose()
    throw error
  }
}

function ownsSession(sessionId: string, owner: Agent): boolean {
  const entry = runtime.sessions.get(sessionId)
  const pending = runtime.pending.get(sessionId)
  return entry?.agent === owner || pending?.agent === owner
}

function activeSink(agent: Agent, controller: AbortController): NativeSink {
  controller.signal.throwIfAborted()
  const current = runtime.sinks.get(agent.id)
  const exchange = runtime.exchanges.get(agent.id)
  if (runtime.controllers.get(agent.id) !== controller || exchange?.state.input.agent !== agent || exchange.state.native !== current)
    throw new Error('BRIDGE_NOTIFICATION_OUTSIDE_TURN: 原生内核在官方回合外或替换后输出。')
  return exchange.state.native
}

function sameBinding(left: KernelBinding | null | undefined, right: KernelBinding): boolean {
  return left?.backend === right.backend && left.nativeSessionId === right.nativeSessionId && left.sessionId === right.sessionId
}

function keyOf(binding: KernelBinding): string {
  return `${binding.backend}:${binding.nativeSessionId}`
}
