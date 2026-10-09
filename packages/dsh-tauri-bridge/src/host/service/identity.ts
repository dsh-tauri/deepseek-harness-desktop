import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KernelBinding } from '../../shared/types'
import type { HostContext } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { z } from 'zod'
import { KERNEL_RECORD_TYPE } from '../config/constants'
import { server } from '../server'
import { loadRuntimeModules } from '../utils/runtime-modules'

const nonemptyId = z.string().min(1).refine(value => value.trim().length > 0)
const bindingSchema = z.object({
  backend: z.enum(['codex', 'claude']),
  nativeSessionId: nonemptyId,
  sessionId: nonemptyId,
}).strict().readonly()
const stateSchema = bindingSchema.nullable()

export const identity = defineService({
  register(): () => void {
    const ctx = getServerContext<HostContext>(server)
    const projections = ctx.get('sessionProjections')
    if (typeof projections?.register !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable')
    return projections.register({
      key: 'bridgeKernel',
      stateSchema,
      init: () => null,
      apply(state, event) {
        const type: string = event.type
        if (type !== KERNEL_RECORD_TYPE || event.ignorable !== true)
          return state
        const candidate = parseBinding(event.data)
        if (state !== null) {
          assertSameBinding(state, candidate)
          return state
        }
        return candidate
      },
      wire: { viewSchema: stateSchema, view: state => state },
      stateVersion: 1,
    })
  },

  async append(agent: Agent, binding: KernelBinding): Promise<number> {
    const candidate = parseBinding(binding)
    if (candidate.sessionId !== agent.session.id)
      throw new Error('BRIDGE_INHERITED_SESSION: A native binding must belong to the exact official session')
    const ctx = getServerContext<HostContext>(server)
    const projections = ctx.get('sessionProjections')
    if (typeof projections?.stateOf !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable')
    const previous = projections.stateOf(agent.session, 'bridgeKernel')
    if (previous === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official kernel projection is not registered')
    if (previous !== null)
      assertSameBinding(parseBinding(previous), candidate)
    const modules = await loadRuntimeModules(ctx.loader)
    if (typeof modules.appendPluginRecord !== 'function' || typeof modules.pluginRecordOf !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official ignorable plugin record capability is unavailable')
    const current = projections.stateOf(agent.session, 'bridgeKernel')
    if (current === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official kernel projection was unregistered')
    if (current !== null) {
      assertSameBinding(parseBinding(current), candidate)
      return agent.session.seq - 1
    }
    const nextSeq = agent.session.seq
    const committedSeq = modules.appendPluginRecord(agent.session, KERNEL_RECORD_TYPE, candidate)
    if (!Number.isSafeInteger(committedSeq) || committedSeq !== nextSeq || agent.session.seq !== nextSeq + 1)
      throw new Error('BRIDGE_BINDING_NOT_COMMITTED: The official plugin record was not appended at the session cursor')
    const committed = projections.stateOf(agent.session, 'bridgeKernel')
    if (committed === undefined || committed === null)
      throw new Error('BRIDGE_BINDING_NOT_COMMITTED: The native identity is absent from the official projection')
    assertSameBinding(parseBinding(committed), candidate)
    return committedSeq
  },

  resolve(agent: Agent): KernelBinding {
    const ctx = getServerContext<HostContext>(server)
    const projections = ctx.get('sessionProjections')
    if (typeof projections?.stateOf !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable')
    const state = projections.stateOf(agent.session, 'bridgeKernel')
    if (state === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official kernel projection is not registered')
    if (state === null)
      throw new Error('BRIDGE_BINDING_MISSING: The official session has no native kernel binding')
    const binding = parseBinding(state)
    if (binding.sessionId !== agent.session.id)
      throw new Error('BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session')
    return binding
  },
})

function parseBinding(value: unknown): KernelBinding {
  const parsed = bindingSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('BRIDGE_BINDING_INVALID: Expected a complete supported backend, nonempty native session id, and nonempty official session id')
  return parsed.data
}

function assertSameBinding(current: KernelBinding, candidate: KernelBinding): void {
  if (current.backend !== candidate.backend || current.nativeSessionId !== candidate.nativeSessionId || current.sessionId !== candidate.sessionId)
    throw new Error('BRIDGE_BINDING_IMMUTABLE: The official native kernel binding cannot be replaced')
}
