import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { KernelBinding } from '../../shared/types'
import type { NativeSink } from '../backends/types'
import type { HostContext, NativeEntry, NativeExecution } from '../types'
import type { OfficialSink } from './sink.types'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, resolveUngroupedSessionPath } from 'dsh-tauri'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { BRIDGE_PROVIDER } from '../config/constants'
import { resetRuntime, runtime } from '../config/runtime'
import { server } from '../server'
import { backend } from './backend'
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
          agentCtx.effect(() => () => startup.abort(new Error('BRIDGE_SETUP_CLOSED')), 'bridge native session setup')
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
          agent.session.append('request/header', { header: { config: { provider: BRIDGE_PROVIDER, model: id } }, reason: 'initial' })
          return {
            commit(): void {
              signal.throwIfAborted()
              agentCtx.fiber.assertActive()
              if (runtime.lifetime !== lifetime || !runtime.ready || !sameBinding(identity.resolve(agent), entry.binding) || agent.session.requestHeader()?.config.provider !== BRIDGE_PROVIDER)
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
    if (input.binding.sessionId !== input.agent.session.id || !sameBinding(ctx.sessionProjections.stateOf(input.agent.session, 'bridgeKernel'), input.binding))
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
        await entry.session.submit(input.messages, state.signal)
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

async function open(agent: Agent, id: KernelBinding['backend'], storedId: string | null, signal: AbortSignal): Promise<NativeEntry> {
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
  const task = connect(agent, id, storedId, controller, AbortSignal.any([runtime.lifetime.signal, controller.signal, signal]))
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

async function connect(agent: Agent, id: KernelBinding['backend'], storedId: string | null, controller: AbortController, signal: AbortSignal): Promise<NativeEntry> {
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
  const native = await factory(resolved.command, agent.session.header.cwd!, storedId, nativeSink, signal)
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
