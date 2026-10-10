import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { KernelBinding } from '../../shared/types'
import type { HostContext, PlatformLoader } from '../types'
import { Context } from '@deepseek-ai/cordis'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import * as sessionModule from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { getServerContext } from 'dsh-h3/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { identity } from './identity'

vi.mock('dsh-h3/utils', () => ({ getServerContext: vi.fn() }))
vi.mock('../server', () => ({ server: vi.fn() }))

const binding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }
let context: Context
let projections: SessionProjectionRegistry
let loader: PlatformLoader

function kernelEvent(value: unknown, seq = 0, options: { type?: string, ignorable?: true } = { ignorable: true }): SessionEvent {
  return {
    type: options.type ?? 'plugin:dsh-tauri-kernel/kernel',
    seq: SessionSeq(seq),
    time: 1000 + seq,
    data: value,
    ...(options.ignorable === true ? { ignorable: true } : {}),
  } as unknown as SessionEvent
}

function sessionFrom(events: readonly SessionEvent[] = [], id = 'session-a'): Session {
  return Session.create(SessionId(id), events)
}

function agentOf(session: Session): Agent {
  return { id: session.id, session } as Agent
}

beforeEach(() => {
  context = new Context()
  projections = new SessionProjectionRegistry(context)
  loader = {
    import: vi.fn(async id => id === '@deepseek-ai/dsh-llm' ? llmModule : sessionModule),
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  vi.mocked(getServerContext).mockReturnValue(context)
})

afterEach(async () => {
  await context.fiber.dispose()
  vi.restoreAllMocks()
})

describe('official kernel identity projection', () => {
  it('registers a nullable complete wire value rather than inferring native identity from model routes', () => {
    identity.register()
    const session = Session.create(SessionId('session-a'))
    expect(projections.stateOf(session, 'bridgeKernel')?.binding).toBeNull()
    expect(projections.snapshot(session)).toEqual({ asOfSeq: -1, values: { bridgeKernel: null } })
    const agent = { ...agentOf(session), options: { provider: 'dsh-tauri-kernel', model: 'codex' } } as Agent
    expect(() => identity.resolve(agent)).toThrow('BRIDGE_BINDING_MISSING')
  })

  it('reads the exact native and owner identity from a legal ignorable official log record', () => {
    identity.register()
    const session = sessionFrom([kernelEvent(binding)])
    expect(identity.resolve(agentOf(session))).toEqual({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    expect(projections.snapshot(session).values).toEqual({ bridgeKernel: { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' } })
    expect(session.deriveMessages()).toEqual([])
    expect(Object.isFrozen(projections.stateOf(session, 'bridgeKernel'))).toBe(true)
  })

  it('restores the whole identity after cold JSON roundtrip using the real official projection restore API', () => {
    identity.register()
    const events: SessionEvent[] = JSON.parse(JSON.stringify([kernelEvent({ backend: 'claude', nativeSessionId: 'native-cold', sessionId: 'session-a' })]))
    const session = sessionFrom(events)
    const restored = projections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored.snapshot).toEqual({ asOfSeq: 0, values: { bridgeKernel: { backend: 'claude', nativeSessionId: 'native-cold', sessionId: 'session-a' } } })
    expect(restored.checkpoint.bridgeKernel).toEqual({ ver: 2, seq: 0, val: { ownerSessionId: 'session-a', inheritedEventCount: 0, inheritedBinding: null, binding: { backend: 'claude', nativeSessionId: 'native-cold', sessionId: 'session-a' } } })
    expect(projections.viewCheckpoint(restored.checkpoint)).toEqual({ bridgeKernel: { backend: 'claude', nativeSessionId: 'native-cold', sessionId: 'session-a' } })
  })

  it('freezes the official binding when a cold checkpoint is parsed and hydrated into the registry', () => {
    identity.register()
    const events: SessionEvent[] = [
      kernelEvent(binding),
      { type: 'session/end-seed', seq: SessionSeq(1), time: 1001, data: {} },
    ]
    const original = sessionFrom(events)
    const checkpoint = JSON.parse(JSON.stringify(projections.checkpoint(original)))
    const restored = sessionFrom(events)
    expect(Object.isFrozen(checkpoint.bridgeKernel.val)).toBe(false)
    projections.hydrate(restored, checkpoint, events, SessionLogOffset(0))
    const state = projections.stateOf(restored, 'bridgeKernel')
    expect(state).toEqual({ ownerSessionId: 'session-a', inheritedEventCount: 0, inheritedBinding: null, binding })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state!.binding)).toBe(true)
    expect(Reflect.set(state!.binding!, 'nativeSessionId', 'replaced-native')).toBe(false)
    expect(Reflect.set(state!, 'ownerSessionId', 'replaced-owner')).toBe(false)
    expect(identity.resolve(agentOf(restored))).toEqual({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    expect(Object.isFrozen(projections.snapshot(restored).values.bridgeKernel)).toBe(true)
  })

  it('ignores foreign record types and records without the legal ignorable marker', () => {
    identity.register()
    const events = [
      kernelEvent({ backend: 'codex' }, 0, { type: 'plugin:other/kernel', ignorable: true }),
      kernelEvent(binding, 1, { type: 'turn/start' }),
    ]
    const session = sessionFrom(events)
    expect(projections.stateOf(session, 'bridgeKernel')?.binding).toBeNull()
    const unmarked = [kernelEvent(binding, 0, {})]
    const restored = projections.restore({}, unmarked, SessionLogOffset(0), Session.create(SessionId('unmarked')).header, SessionLogOffset(0))
    expect(restored.snapshot.values.bridgeKernel).toBeNull()
  })

  it.each([
    {},
    null,
    { backend: 'codex', nativeSessionId: 'native-a' },
    { ...binding, backend: 'dsh' },
    { ...binding, backend: 'unknown' },
    { ...binding, nativeSessionId: '' },
    { ...binding, nativeSessionId: ' ' },
    { ...binding, sessionId: '' },
    { ...binding, sessionId: '\t' },
    { ...binding, delta: true },
  ])('rejects malformed or incomplete plugin identity without accepting a partial payload: %j', (value) => {
    identity.register()
    const session = sessionFrom([kernelEvent(value)])
    expect(() => projections.stateOf(session, 'bridgeKernel')).toThrow('BRIDGE_BINDING_INVALID')
  })

  it('reuses the same state reference for duplicate complete records and unrelated official events', () => {
    identity.register()
    const first = kernelEvent(binding)
    const second = kernelEvent({ ...binding }, 1)
    const third: SessionEvent = { type: 'turn/start', seq: SessionSeq(2), time: 1002, data: { turn: 0 } }
    const initial = projections.restore({}, [first], SessionLogOffset(0), Session.create(SessionId('session-a')).header, SessionLogOffset(0))
    const session = sessionFrom([first, second, third])
    projections.hydrate(session, initial.checkpoint, [first], SessionLogOffset(0))
    const changed = vi.fn()
    projections.onChanged(changed)
    context.emit('session/event', session, second)
    context.emit('session/event', session, third)
    expect(changed).not.toHaveBeenCalled()
    expect(projections.stateOf(session, 'bridgeKernel')).toEqual({ ownerSessionId: 'session-a', inheritedEventCount: 0, inheritedBinding: null, binding })
    expect(projections.checkpoint(session).bridgeKernel!.val).toEqual({ ownerSessionId: 'session-a', inheritedEventCount: 0, inheritedBinding: null, binding })
  })

  it.each([
    { ...binding, backend: 'claude' as const },
    { ...binding, nativeSessionId: 'native-b' },
  ])('refuses conflicting complete binding history on cold replay: %j', (different) => {
    identity.register()
    const session = sessionFrom([kernelEvent(binding), kernelEvent(different, 1)])
    expect(() => projections.stateOf(session, 'bridgeKernel')).toThrow('BRIDGE_BINDING_IMMUTABLE')
  })

  it('retains an inherited parent identity only as a non-executable fork source', () => {
    identity.register()
    const parent = sessionFrom([kernelEvent(binding)])
    const child = Session.create(SessionId('session-child'), [kernelEvent(binding)], {
      ...parent.header,
      id: SessionId('session-child'),
      parentSession: parent.id,
      isSeeded: true,
    }, SessionLogOffset(1))
    const before = child.seq
    const append = vi.spyOn(child, 'append')
    expect(projections.stateOf(child, 'bridgeKernel')).toEqual({ ownerSessionId: 'session-child', inheritedEventCount: 1, inheritedBinding: binding, binding: null })
    expect(projections.snapshot(child).values.bridgeKernel).toBeNull()
    expect(identity.inherited(child)).toEqual(binding)
    expect(() => identity.resolve(agentOf(child))).toThrow('BRIDGE_BINDING_MISSING')
    expect(child.seq).toBe(before)
    expect(append).not.toHaveBeenCalled()
    expect(loader.import).not.toHaveBeenCalled()
    expect(identity.resolve(agentOf(parent))).toEqual(binding)
  })

  it('rejects a foreign owner record outside the exact inherited prefix on cold replay', () => {
    identity.register()
    const foreign = { ...binding, sessionId: 'session-other' }
    const original = sessionFrom([kernelEvent(foreign)])
    expect(() => projections.stateOf(original, 'bridgeKernel')).toThrow('BRIDGE_INHERITED_SESSION')
    const events: SessionEvent[] = [kernelEvent(binding), { type: 'session/end-seed', seq: SessionSeq(1), time: 1001, data: { inherited: true } }, kernelEvent(foreign, 2)]
    const child = Session.create(SessionId('session-child'), events, {
      ...original.header,
      id: SessionId('session-child'),
      parentSession: SessionId('session-a'),
      isSeeded: true,
    }, SessionLogOffset(1))
    expect(() => projections.restore({}, events, SessionLogOffset(0), child.header, child.inheritedEventCount)).toThrow('BRIDGE_INHERITED_SESSION')
  })

  it('accepts the first child-owned record at the exact fork cut and keeps it immutable', () => {
    identity.register()
    const parent = sessionFrom([kernelEvent(binding)])
    const childBinding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-child', sessionId: 'session-child' }
    const child = Session.create(SessionId('session-child'), [kernelEvent(binding)], {
      ...parent.header,
      id: SessionId('session-child'),
      parentSession: parent.id,
      isSeeded: true,
    }, SessionLogOffset(1))
    const events = [kernelEvent(binding), kernelEvent(childBinding, 1)]
    const restored = projections.restore({}, events, SessionLogOffset(0), child.header, child.inheritedEventCount)
    expect(restored.snapshot.values.bridgeKernel).toEqual(childBinding)
    expect(restored.checkpoint.bridgeKernel.val).toEqual({ ownerSessionId: 'session-child', inheritedEventCount: 1, inheritedBinding: binding, binding: childBinding })
    const conflicting = [...events, kernelEvent({ ...childBinding, nativeSessionId: 'native-replacement' }, 2)]
    expect(() => projections.restore({}, conflicting, SessionLogOffset(0), child.header, child.inheritedEventCount)).toThrow('BRIDGE_BINDING_IMMUTABLE')
    const foreign = [...events, kernelEvent(binding, 2)]
    expect(() => projections.restore({}, foreign, SessionLogOffset(0), child.header, child.inheritedEventCount)).toThrow('BRIDGE_INHERITED_SESSION')
    expect(identity.resolve(agentOf(parent))).toEqual(binding)
  })

  it('rejects a child-owned record that tries to reuse its inherited native session', () => {
    identity.register()
    const parent = sessionFrom([kernelEvent(binding)])
    const events = [kernelEvent(binding), kernelEvent({ ...binding, sessionId: 'session-child' }, 1)]
    expect(() => projections.restore({}, events, SessionLogOffset(0), {
      ...parent.header,
      id: SessionId('session-child'),
      parentSession: parent.id,
      isSeeded: true,
    }, SessionLogOffset(1))).toThrow('BRIDGE_INHERITED_SESSION: A fork must receive a distinct native session identity')
  })

  it('does not mistake a grandparent prefix binding for an unbound immediate fork parent', () => {
    identity.register()
    const parent = sessionFrom([kernelEvent(binding)])
    const child = Session.create(SessionId('session-grandchild'), [kernelEvent(binding)], {
      ...parent.header,
      id: SessionId('session-grandchild'),
      parentSession: SessionId('session-child'),
      isSeeded: true,
    }, SessionLogOffset(1))
    expect(projections.snapshot(child).values.bridgeKernel).toBeNull()
    expect(() => identity.inherited(child)).toThrow('BRIDGE_INHERITED_SESSION: The inherited native binding must belong to the exact official fork parent')
    expect(() => identity.resolve(agentOf(child))).toThrow('BRIDGE_BINDING_MISSING')
  })

  it('cold-restores a descendant using only its own identity while retaining the exact immediate fork parent', () => {
    identity.register()
    const childBinding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-child', sessionId: 'session-child' }
    const descendantBinding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-grandchild', sessionId: 'session-grandchild' }
    const events: SessionEvent[] = JSON.parse(JSON.stringify([kernelEvent(binding), kernelEvent(childBinding, 1), { type: 'session/end-seed', seq: 2, time: 1002, data: { inherited: true } }, kernelEvent(descendantBinding, 3)]))
    const descendant = Session.create(SessionId('session-grandchild'), events, {
      ...Session.create(SessionId('session-grandchild')).header,
      parentSession: SessionId('session-child'),
      isSeeded: true,
    }, SessionLogOffset(2))
    const restored = projections.restore({}, events, SessionLogOffset(0), descendant.header, descendant.inheritedEventCount)
    const expectedState = { ownerSessionId: 'session-grandchild', inheritedEventCount: 2, inheritedBinding: childBinding, binding: descendantBinding }
    expect(restored.snapshot.values.bridgeKernel).toEqual(descendantBinding)
    expect(restored.checkpoint.bridgeKernel).toEqual({ ver: 2, seq: 3, val: expectedState })
    const checkpoint = JSON.parse(JSON.stringify(restored.checkpoint))
    expect(projections.viewCheckpoint(checkpoint)).toEqual({ bridgeKernel: descendantBinding })
    projections.hydrate(descendant, checkpoint, events, SessionLogOffset(0))
    expect(projections.stateOf(descendant, 'bridgeKernel')).toEqual(expectedState)
    expect(identity.inherited(descendant)).toEqual(childBinding)
    expect(identity.resolve(agentOf(descendant))).toEqual(descendantBinding)
    expect(Object.isFrozen(projections.stateOf(descendant, 'bridgeKernel')!.binding)).toBe(true)
    expect(Object.isFrozen(projections.stateOf(descendant, 'bridgeKernel')!.inheritedBinding)).toBe(true)
  })

  it('discards old version-one checkpoints instead of exposing an inherited binding as the child identity', () => {
    identity.register()
    const events = [kernelEvent(binding)]
    const child = Session.create(SessionId('session-child'), events, {
      ...Session.create(SessionId('session-child')).header,
      parentSession: SessionId('session-a'),
      isSeeded: true,
    }, SessionLogOffset(1))
    const checkpoint = { bridgeKernel: { ver: 1, seq: SessionSeq(0), val: binding } }
    expect(projections.viewCheckpoint(checkpoint)).toEqual({})
    expect(projections.restoreFloor(checkpoint)).toBe(0)
    const restored = projections.restore(checkpoint, events, SessionLogOffset(0), child.header, child.inheritedEventCount)
    expect(restored.snapshot).toEqual({ asOfSeq: 0, values: { bridgeKernel: null } })
    expect(restored.checkpoint.bridgeKernel).toEqual({ ver: 2, seq: 0, val: { ownerSessionId: 'session-child', inheritedEventCount: 1, inheritedBinding: binding, binding: null } })
  })

  it('removes the projection capability when its registering contribution unloads', () => {
    const unregister = identity.register()
    const session = sessionFrom([kernelEvent(binding)])
    expect(identity.resolve(agentOf(session))).toEqual(binding)
    unregister()
    expect(projections.stateOf(session, 'bridgeKernel')).toBeUndefined()
    expect(projections.snapshot(session).values).toEqual({})
    expect(() => identity.resolve(agentOf(session))).toThrow('BRIDGE_CORE_UNAVAILABLE')
  })

  it('fails before any append when the actual alpha official module lacks the plugin record writer', async () => {
    identity.register()
    const session = Session.create(SessionId('session-a'))
    const append = vi.spyOn(session, 'append')
    const before = session.seq
    expect(Reflect.get(sessionModule, 'appendPluginRecord')).toBeUndefined()
    expect(Reflect.get(sessionModule, 'pluginRecordOf')).toBeUndefined()
    await expect(identity.append(agentOf(session), binding)).rejects.toThrow('BRIDGE_CORE_UNAVAILABLE')
    expect(session.seq).toBe(before)
    expect(append).not.toHaveBeenCalled()
    expect(projections.stateOf(session, 'bridgeKernel')?.binding).toBeNull()
  })

  it('rejects a different binding before importing runtime capabilities or modifying the log', async () => {
    identity.register()
    const session = sessionFrom([kernelEvent(binding)])
    const before = session.seq
    const append = vi.spyOn(session, 'append')
    await expect(identity.append(agentOf(session), { ...binding, nativeSessionId: 'native-b' })).rejects.toThrow('BRIDGE_BINDING_IMMUTABLE')
    expect(loader.import).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(session.seq).toBe(before)
    expect(identity.resolve(agentOf(session))).toEqual(binding)
  })

  it('rejects a requested foreign owner before importing runtime capabilities or modifying the log', async () => {
    identity.register()
    const session = Session.create(SessionId('session-a'))
    const append = vi.spyOn(session, 'append')
    await expect(identity.append(agentOf(session), { ...binding, sessionId: 'session-other' })).rejects.toThrow('BRIDGE_INHERITED_SESSION')
    expect(loader.import).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(session.seq).toBe(0)
  })

  it('requires the registered projection instead of treating capability absence as an empty identity', async () => {
    const session = Session.create(SessionId('session-a'))
    await expect(identity.append(agentOf(session), binding)).rejects.toThrow('BRIDGE_CORE_UNAVAILABLE')
    expect(loader.import).not.toHaveBeenCalled()
    expect(session.seq).toBe(0)
  })

  it('rejects invalid append payloads before any log write', async () => {
    identity.register()
    const session = Session.create(SessionId('session-a'))
    await expect(identity.append(agentOf(session), { ...binding, nativeSessionId: '  ' })).rejects.toThrow('BRIDGE_BINDING_INVALID')
    expect(loader.import).not.toHaveBeenCalled()
    expect(session.seq).toBe(0)
  })
})
