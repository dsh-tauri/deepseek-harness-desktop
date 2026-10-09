import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { KernelBinding, KernelProjectionState } from '../../shared/types'
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
const viewSchema = bindingSchema.nullable()
const stateSchema = z.object({
  ownerSessionId: nonemptyId,
  inheritedEventCount: z.number().int().nonnegative(),
  inheritedBinding: viewSchema,
  binding: viewSchema,
}).strict().readonly()

export const identity = defineService({
  register(): () => void {
    const ctx = getServerContext<HostContext>(server)
    const projections = ctx.get('sessionProjections')
    if (typeof projections?.register !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable')
    return projections.register({
      key: 'bridgeKernel',
      stateSchema,
      init: (header, inheritedEventCount) => Object.freeze({ ownerSessionId: header.id, inheritedEventCount, inheritedBinding: null, binding: null }),
      apply(state, event) {
        const type: string = event.type
        if (type !== KERNEL_RECORD_TYPE || event.ignorable !== true)
          return state
        const candidate = parseBinding(event.data)
        if (event.seq < state.inheritedEventCount) {
          if (state.inheritedBinding !== null && sameBinding(state.inheritedBinding, candidate))
            return state
          return Object.freeze({ ...state, inheritedBinding: candidate })
        }
        if (candidate.sessionId !== state.ownerSessionId)
          throw new Error('BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session')
        if (state.binding !== null) {
          assertSameBinding(state.binding, candidate)
          return state
        }
        assertDistinctNative(state.inheritedBinding, candidate)
        return Object.freeze({ ...state, binding: candidate })
      },
      wire: { viewSchema, view: state => state.binding },
      stateVersion: 2,
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
    assertOwner(previous, agent.session)
    if (previous.binding !== null)
      assertSameBinding(parseBinding(previous.binding), candidate)
    assertDistinctNative(previous.inheritedBinding, candidate)
    const modules = await loadRuntimeModules(ctx.loader)
    if (typeof modules.appendPluginRecord !== 'function' || typeof modules.pluginRecordOf !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official ignorable plugin record capability is unavailable')
    const current = projections.stateOf(agent.session, 'bridgeKernel')
    if (current === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official kernel projection was unregistered')
    assertOwner(current, agent.session)
    if (current.binding !== null) {
      assertSameBinding(parseBinding(current.binding), candidate)
      return agent.session.seq - 1
    }
    assertDistinctNative(current.inheritedBinding, candidate)
    const nextSeq = agent.session.seq
    const committedSeq = modules.appendPluginRecord(agent.session, KERNEL_RECORD_TYPE, candidate)
    if (!Number.isSafeInteger(committedSeq) || committedSeq !== nextSeq || agent.session.seq !== nextSeq + 1)
      throw new Error('BRIDGE_BINDING_NOT_COMMITTED: The official plugin record was not appended at the session cursor')
    const committed = projections.stateOf(agent.session, 'bridgeKernel')
    if (committed === undefined || committed.binding === null)
      throw new Error('BRIDGE_BINDING_NOT_COMMITTED: The native identity is absent from the official projection')
    assertOwner(committed, agent.session)
    assertSameBinding(parseBinding(committed.binding), candidate)
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
    assertOwner(state, agent.session)
    if (state.binding === null)
      throw new Error('BRIDGE_BINDING_MISSING: The official session has no native kernel binding')
    const binding = parseBinding(state.binding)
    if (binding.sessionId !== agent.session.id)
      throw new Error('BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session')
    return binding
  },

  inherited(value: Session): KernelBinding | null {
    const ctx = getServerContext<HostContext>(server)
    const projections = ctx.get('sessionProjections')
    if (typeof projections?.stateOf !== 'function')
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable')
    const state = projections.stateOf(value, 'bridgeKernel')
    if (state === undefined)
      throw new Error('BRIDGE_CORE_UNAVAILABLE: The official kernel projection is not registered')
    assertOwner(state, value)
    if (state.inheritedBinding === null)
      return null
    const binding = parseBinding(state.inheritedBinding)
    if (value.header.isSeeded !== true || !value.header.parentSession || state.inheritedEventCount === 0 || binding.sessionId !== value.header.parentSession)
      throw new Error('BRIDGE_INHERITED_SESSION: The inherited native binding must belong to the exact official fork parent')
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
  if (!sameBinding(current, candidate))
    throw new Error('BRIDGE_BINDING_IMMUTABLE: The official native kernel binding cannot be replaced')
}

function sameBinding(current: KernelBinding, candidate: KernelBinding): boolean {
  return current.backend === candidate.backend && current.nativeSessionId === candidate.nativeSessionId && current.sessionId === candidate.sessionId
}

function assertOwner(state: KernelProjectionState, session: Session): void {
  if (state.ownerSessionId !== session.id || state.inheritedEventCount !== session.inheritedEventCount)
    throw new Error('BRIDGE_INHERITED_SESSION: The native projection must belong to the exact official session and fork boundary')
}

function assertDistinctNative(inherited: KernelBinding | null, candidate: KernelBinding): void {
  if (inherited?.backend === candidate.backend && inherited.nativeSessionId === candidate.nativeSessionId)
    throw new Error('BRIDGE_INHERITED_SESSION: A fork must receive a distinct native session identity')
}
