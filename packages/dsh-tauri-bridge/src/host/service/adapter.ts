import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmAdapter, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AdmittedStep, HostContext } from '../types'
import { Buffer } from 'node:buffer'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { BRIDGE_PROVIDER } from '../config/constants'
import { runtime } from '../config/runtime'
import { server } from '../server'
import { loadRuntimeModules } from '../utils/runtime-modules'
import { identity } from './identity'
import { session } from './session'
import { sink } from './sink'

export const adapter = defineService({
  async register(): Promise<() => void> {
    const ctx = getServerContext<HostContext>(server)
    const modules = await loadRuntimeModules(ctx.loader)
    runtime.lifetime.signal.throwIfAborted()
    class NativeAdapter extends modules.LlmAdapter {
      providerInfo(provider: string): { id: string, name: string } {
        return { id: provider, name: '本机内核桥接' }
      }

      providerRetryPolicy(): ResolvedRetryPolicy {
        return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 }
      }

      async listModels(): Promise<readonly LlmModelInfo[]> {
        return []
      }

      async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
        signal?.throwIfAborted()
        if (provider !== BRIDGE_PROVIDER || (model !== 'codex' && model !== 'claude'))
          throw new Error('BRIDGE_ROUTE_INVALID: 原生内核路由无效。')
        return { provider, id: model, name: model === 'codex' ? 'Codex' : 'Claude' }
      }

      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        return adapter.stream(options)
      }
    }
    const dispose = ctx.llm.registerAdapter([BRIDGE_PROVIDER], new NativeAdapter() as LlmAdapter)
    runtime.ready = true
    return () => {
      runtime.ready = false
      dispose()
    }
  },

  async admit(payload: Omit<AdmittedStep, 'request' | 'dispatched'>, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const closing = runtime.closings.get(payload.agent.id)
    if (closing)
      await closing.catch(() => undefined)
    let decision: PreStepDecision
    try {
      decision = await next()
      const current = runtime.exchanges.get(payload.agent.id)
      if (current) {
        const state = current.state
        if (decision.kind !== 'enter' || payload.signal.aborted || state.failure !== undefined || state.input.agent !== payload.agent || state.input.turn !== payload.turn || state.input.signal !== payload.signal || payload.messages.some(message => continuationMessage(message, state.input.messages)) || decision.messages.some(message => continuationMessage(message, state.input.messages) && !payload.messages.includes(message)) || state.finalConsumed) {
          state.controller.abort(state.failure ?? new Error('BRIDGE_STEERING_UNSUPPORTED: 原生回合不支持中途追加指令或提前结束。'))
          await session.finish(payload.agent, state.input.turn)
          throw state.signal.reason
        }
      }
    }
    catch (error) {
      const current = runtime.exchanges.get(payload.agent.id)
      if (current) {
        current.state.controller.abort(error)
        await session.finish(payload.agent, current.state.input.turn)
      }
      throw error
    }
    if (decision.kind !== 'enter' || payload.signal.aborted)
      return decision
    const ctx = getServerContext<HostContext>(server)
    const binding = ctx.sessionProjections.stateOf(payload.agent.session, 'bridgeKernel')
    if (binding === null || binding === undefined) {
      if (payload.agent.session.requestHeader()?.config.provider === BRIDGE_PROVIDER)
        throw new Error('BRIDGE_BINDING_MISSING: 原生内核的官方身份记录缺失。')
      return decision
    }
    identity.resolve(payload.agent)
    session.validateComposition(payload.agent)
    assertLive(payload.agent, payload.signal)
    runtime.steps.set(payload.agent.id, { ...payload, messages: decision.messages.filter(nativeMessage), dispatched: false })
    return decision
  },

  async request(payload: { agent: Agent, signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> {
    const config = await next()
    const ctx = getServerContext<HostContext>(server)
    const projected = ctx.sessionProjections.stateOf(payload.agent.session, 'bridgeKernel')
    if (projected === null || projected === undefined) {
      if (config.provider === BRIDGE_PROVIDER || payload.agent.session.requestHeader()?.config.provider === BRIDGE_PROVIDER)
        throw new Error('BRIDGE_BINDING_MISSING: 原生内核的官方身份记录缺失。')
      return config
    }
    const binding = identity.resolve(payload.agent)
    assertLive(payload.agent, payload.signal)
    if (config.provider !== BRIDGE_PROVIDER || config.model !== binding.backend || config.reasoningEffort !== undefined || config.maxTokens !== undefined || config.temperature !== undefined || config.stop !== undefined)
      throw new Error('BRIDGE_KERNEL_IMMUTABLE: 已绑定会话不能切换内核或由 DSH 覆写原生选项。')
    return config
  },

  async* capture(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (options.provider !== BRIDGE_PROVIDER) {
      yield* next()
      return
    }
    const ctx = getServerContext<HostContext>(server)
    const modules = await loadRuntimeModules(ctx.loader)
    if (options.purpose !== undefined || !modules.isAgentLoopRequest(options) || options.sessionId === undefined || options.signal === undefined)
      throw new Error('BRIDGE_AUXILIARY_REQUEST: 原生内核仅接受官方会话回合，不支持辅助模型调用。')
    const admitted = runtime.steps.get(options.sessionId)
    if (!admitted || admitted.dispatched || admitted.request !== undefined || admitted.signal !== options.signal)
      throw new Error('BRIDGE_STEP_UNAVAILABLE: 没有对应的官方已接纳回合。')
    assertLive(admitted.agent, options.signal)
    const boundary = ctx.sessionProjections.stateOf(admitted.agent.session, 'turnBoundary')
    if (boundary?.lastTurn !== admitted.turn || boundary.openTurnStartSeq === null || boundary.lastStepBoundary?.kind !== 'start' || boundary.lastStepBoundary.seq !== boundary.lastStepStartSeq)
      throw new Error('BRIDGE_STEP_UNAVAILABLE: 官方回合边界不再有效。')
    admitted.request = options
    try {
      yield* next()
    }
    finally {
      if (runtime.steps.get(options.sessionId) === admitted)
        runtime.steps.delete(options.sessionId)
    }
  },

  async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const admitted = options.sessionId === undefined ? undefined : runtime.steps.get(options.sessionId)
    if (!admitted || admitted.dispatched || !admitted.request || options.purpose !== undefined || options.signal !== admitted.signal || options.provider !== BRIDGE_PROVIDER || options.model !== admitted.request.model)
      throw new Error('BRIDGE_STEP_UNAVAILABLE: 原生请求未通过官方回合检查。')
    const binding = identity.resolve(admitted.agent)
    if (binding.backend !== options.model)
      throw new Error('BRIDGE_BINDING_MISMATCH: 请求与已提交的原生内核不一致。')
    assertLive(admitted.agent, admitted.signal)
    admitted.dispatched = true
    const official = await session.execute({ ...admitted, binding })
    const state = official.state
    let yieldedBoundary = false
    try {
      while (true) {
        assertLive(admitted.agent, admitted.signal)
        state.signal.throwIfAborted()
        if (state.queue.length === 0) {
          if (state.done) {
            if (state.failure !== undefined)
              throw state.failure
            throw new Error('BRIDGE_STREAM_UNSETTLED: 原生回合缺少终止边界。')
          }
          let wake!: () => void
          await new Promise<void>((resolve) => {
            wake = resolve
            state.wake = wake
            state.signal.addEventListener('abort', wake, { once: true })
          }).finally(() => {
            state.signal.removeEventListener('abort', wake)
            if (state.wake === wake)
              state.wake = undefined
          })
          continue
        }
        const chunk = state.queue.shift()!
        state.queuedBytes -= Buffer.byteLength(JSON.stringify(chunk))
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
          state.tools.get(chunk.block.id)!.step = admitted.step
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'stop') {
            await state.task
            if (!state.done || state.failure !== undefined)
              throw state.failure ?? new Error('BRIDGE_NATIVE_UNSETTLED: 原生回合尚未停止。')
            state.finalConsumed = true
          }
          yieldedBoundary = true
        }
        yield chunk
        if (yieldedBoundary)
          return
      }
    }
    finally {
      if (!yieldedBoundary) {
        state.controller.abort(new Error('BRIDGE_STREAM_CLOSED'))
        await session.finish(admitted.agent, state.input.turn)
      }
      if (runtime.steps.get(admitted.agent.id) === admitted)
        runtime.steps.delete(admitted.agent.id)
    }
  },

  async remove(agent: Agent): Promise<void> {
    const current = runtime.exchanges.get(agent.id)
    if (current?.state.input.agent === agent)
      await session.finish(agent, current.state.input.turn)
    const admitted = runtime.steps.get(agent.id)
    if (admitted?.agent === agent)
      runtime.steps.delete(agent.id)
    await session.remove(agent.id, agent)
  },

  end(value: Session, event: SessionEvent): void {
    sink.commitTool(value, event)
    if (event.type === 'step/end' || event.type === 'turn/end') {
      runtime.steps.delete(value.id)
      const current = runtime.exchanges.get(value.id)
      if (event.type === 'turn/end' && current?.state.input.agent.session === value) {
        const task = session.finish(current.state.input.agent, current.state.input.turn)
        void task.catch((error: unknown) => getServerContext<HostContext>(server).logger.warn('dsh-tauri-bridge: native turn drainage failed', error))
      }
    }
  },
})

function nativeMessage(message: UserMessage): boolean {
  const source: string = message.source.kind
  return source !== 'runtime-context' && source !== 'time-context'
}

function continuationMessage(message: UserMessage, entered: readonly UserMessage[]): boolean {
  const source: string = message.source.kind
  if (source === 'agent-instructions')
    return !entered.some(previous => JSON.stringify(previous.source) === JSON.stringify(message.source) && JSON.stringify(previous.content) === JSON.stringify(message.content))
  return nativeMessage(message)
}

function assertLive(agent: Agent, signal: AbortSignal): void {
  signal.throwIfAborted()
  runtime.lifetime.signal.throwIfAborted()
  if (!runtime.ready)
    throw new Error('BRIDGE_DISPOSED: 原生桥接已卸载。')
  const ctx = getServerContext<HostContext>(server)
  if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session || agent.status !== 'running')
    throw new Error('BRIDGE_AGENT_REPLACED: 官方会话已关闭或被替换。')
}
