import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { NativeModelCatalog, NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { HostContext } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { z } from 'zod'
import { MODEL_RECORD_TYPE } from '../config/constants'
import { runtime } from '../config/runtime'
import { server } from '../server'
import { waitFor } from '../utils/abort'
import { loadRuntimeModules } from '../utils/runtime-modules'
import { checkpoint } from './checkpoint'
import { identity } from './identity'
import { session } from './session'

const identifier = z.string().min(1).max(512).refine(value => value.trim().length > 0)
const optionsSchema = z.object({ model: identifier.nullable(), reasoningEffort: identifier.nullable() }).strict().readonly()
const catalogSchema = z.object({
  models: z.array(z.object({
    id: identifier,
    name: z.string().min(1),
    description: z.string().optional(),
    reasoning: z.object({
      efforts: z.array(z.object({ id: identifier, name: z.string().min(1), description: z.string().optional() })).min(1),
      defaultEffort: identifier.optional(),
    }).optional(),
  })).max(2048),
  defaultModel: identifier.optional(),
})

export const model = defineService({
  register(): () => void {
    const ctx = getServerContext<HostContext>(server)
    return ctx.sessionProjections.register({
      key: 'bridgeModel',
      stateSchema: optionsSchema,
      init: () => ({ model: null, reasoningEffort: null }),
      apply(state, event) {
        if ((event.type as string) !== MODEL_RECORD_TYPE || event.ignorable !== true)
          return state
        const next = parseOptions(event.data)
        return sameOptions(state, next) ? state : next
      },
      wire: { viewSchema: optionsSchema, view: state => state },
      stateVersion: 1,
    })
  },

  resolve(agent: Agent): NativeTurnOptions {
    const ctx = getServerContext<HostContext>(server)
    const value = ctx.sessionProjections.stateOf(agent.session, 'bridgeModel')
    if (value === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: 原生模型投影不可用。')
    return parseOptions(value)
  },

  async forTurn(agent: Agent, signal: AbortSignal): Promise<NativeTurnOptions> {
    const lifetime = runtime.lifetime
    const scoped = AbortSignal.any([signal, lifetime.signal])
    while (true) {
      const pending = runtime.modelWrites.get(agent)
      if (pending)
        await waitFor(pending.catch(() => undefined), scoped)
      await checkpoint.flush(agent, scoped)
      assertLive(agent, lifetime)
      scoped.throwIfAborted()
      if (!runtime.modelWrites.has(agent) && checkpoint.isVerified(agent))
        return model.resolve(agent)
    }
  },

  async getCatalog(sessionId: string): Promise<NativeModelDirectory> {
    const lifetime = runtime.lifetime
    const agent = await resolveAgent(sessionId, lifetime)
    const binding = identity.resolve(agent)
    const catalog = await getCatalog(agent, lifetime)
    assertLive(agent, lifetime)
    return { ...catalog, backend: binding.backend, current: model.resolve(agent) }
  },

  async select(sessionId: string, options: NativeTurnOptions): Promise<NativeTurnOptions> {
    const next = parseOptions(options)
    const lifetime = runtime.lifetime
    const agent = await resolveAgent(sessionId, lifetime)
    identity.resolve(agent)
    const previous = runtime.modelWrites.get(agent)
    const task = (async () => {
      if (previous)
        await waitFor(previous.catch(() => undefined), lifetime.signal)
      const catalog = await getCatalog(agent, lifetime)
      assertSelection(catalog, next)
      assertLive(agent, lifetime)
      const ctx = getServerContext<HostContext>(server)
      const modules = await waitFor(loadRuntimeModules(ctx.loader), lifetime.signal)
      assertLive(agent, lifetime)
      if (typeof modules.appendPluginRecord !== 'function' || typeof modules.pluginRecordOf !== 'function')
        throw new Error('BRIDGE_CORE_UNAVAILABLE: 原生模型选择的官方记录接口不可用。')
      const current = model.resolve(agent)
      if (!sameOptions(current, next)) {
        const cursor = agent.session.seq
        const seq = modules.appendPluginRecord(agent.session, MODEL_RECORD_TYPE, next)
        checkpoint.mark(agent, MODEL_RECORD_TYPE, seq, next)
        if (seq !== cursor || agent.session.seq !== cursor + 1 || !sameOptions(model.resolve(agent), next))
          throw new Error('BRIDGE_MODEL_NOT_COMMITTED: 原生模型选择未写入官方会话。')
      }
      await checkpoint.flush(agent, lifetime.signal, true)
      assertLive(agent, lifetime)
    })()
    runtime.modelWrites.set(agent, task)
    try {
      await task
      return next
    }
    finally {
      if (runtime.modelWrites.get(agent) === task)
        runtime.modelWrites.delete(agent)
    }
  },
})

function parseOptions(value: unknown): NativeTurnOptions {
  const parsed = optionsSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('BRIDGE_MODEL_INVALID: 模型与推理深度必须是完整的原生选项。')
  return parsed.data
}

async function resolveAgent(sessionId: string, lifetime: AbortController): Promise<Agent> {
  const ctx = getServerContext<HostContext>(server)
  lifetime.signal.throwIfAborted()
  let agent = ctx.agents.get(sessionId as SessionId)
  if (!agent) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function')
      throw new Error('BRIDGE_SESSION_UNAVAILABLE: 无法恢复官方会话。')
    const resolved = await waitFor<Awaited<ReturnType<HostContext['sessionController']['resolveAgent']>>>(controller.resolveAgent(sessionId as SessionId), lifetime.signal)
    if ('error' in resolved)
      throw resolved.error
    agent = resolved.agent
  }
  if (!agent)
    throw new Error('BRIDGE_SESSION_UNAVAILABLE: 官方会话未返回有效的代理。')
  assertLive(agent, lifetime)
  identity.resolve(agent)
  return agent
}

async function getCatalog(agent: Agent, lifetime: AbortController): Promise<NativeModelCatalog> {
  assertLive(agent, lifetime)
  const native = await waitFor(session.connect(agent, lifetime.signal), lifetime.signal)
  assertLive(agent, lifetime)
  if (typeof native.models !== 'function')
    throw new Error('BRIDGE_MODEL_UNSUPPORTED: 当前本机内核未提供模型目录。')
  const parsed = catalogSchema.safeParse(await waitFor(native.models(lifetime.signal), lifetime.signal))
  assertLive(agent, lifetime)
  if (!parsed.success)
    throw new Error('BRIDGE_MODEL_CATALOG_INVALID: 本机内核返回了不完整的模型目录。')
  const catalog = parsed.data
  const ids = new Set<string>()
  for (const entry of catalog.models) {
    if (ids.has(entry.id))
      throw new Error('BRIDGE_MODEL_CATALOG_INVALID: 本机模型目录包含重复标识。')
    ids.add(entry.id)
    const efforts = entry.reasoning?.efforts
    if (efforts && (new Set(efforts.map(effort => effort.id)).size !== efforts.length || (entry.reasoning?.defaultEffort !== undefined && !efforts.some(effort => effort.id === entry.reasoning?.defaultEffort))))
      throw new Error('BRIDGE_MODEL_CATALOG_INVALID: 本机模型的推理深度目录不一致。')
  }
  if (catalog.defaultModel !== undefined && !ids.has(catalog.defaultModel))
    throw new Error('BRIDGE_MODEL_CATALOG_INVALID: 原生默认模型未包含在模型目录中。')
  return catalog
}

function assertSelection(catalog: NativeModelCatalog, options: NativeTurnOptions): void {
  const id = options.model ?? catalog.defaultModel
  const entry = catalog.models.find(item => item.id === id)
  if (options.model !== null && entry === undefined)
    throw new Error('BRIDGE_MODEL_UNAVAILABLE: 请选择当前原生内核支持的模型。')
  if (options.reasoningEffort !== null && !entry?.reasoning?.efforts.some(effort => effort.id === options.reasoningEffort))
    throw new Error('BRIDGE_REASONING_UNAVAILABLE: 当前原生模型不支持该推理深度。')
}

function sameOptions(left: NativeTurnOptions, right: NativeTurnOptions): boolean {
  return left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

function assertLive(agent: Agent, lifetime: AbortController): void {
  lifetime.signal.throwIfAborted()
  const ctx = getServerContext<HostContext>(server)
  if (!runtime.ready || runtime.lifetime !== lifetime || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session)
    throw new Error('BRIDGE_AGENT_REPLACED: 原生会话已关闭或被替换。')
}
