import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session as OfficialSession, SessionStore as OfficialSessionStore, SessionEvent } from '@deepseek-ai/dsh-session'
import type { KernelBinding } from '../../shared/types'
import type { HostContext, PlatformLoader, RuntimeModules } from '../types'
import { Context } from '@deepseek-ai/cordis'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { getServerContext } from 'dsh-h3/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRuntimeModules } from '../utils/runtime-modules'
import { identity } from './identity'

vi.mock('dsh-h3/utils', () => ({ getServerContext: vi.fn() }))
vi.mock('../server', () => ({ server: vi.fn() }))

const currentSessionPackage: string = 'dsh-session-current'
const sessionModule = await import(currentSessionPackage) as unknown as typeof import('@deepseek-ai/dsh-session') & Required<Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>>
const { Session, SessionId, SessionStore } = sessionModule
const binding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }
let context: Context
let sessions: OfficialSessionStore
let projections: SessionProjectionRegistry
let loader: PlatformLoader
let published: { sessionId: string, event: SessionEvent }[]

function agentOf(session: OfficialSession): Agent {
  return { id: session.id, session } as Agent
}

function eventsOf(session: OfficialSession): SessionEvent[] {
  return published.filter(value => value.sessionId === session.id).map(value => value.event)
}

function gateSessionImport(): { promise: Promise<typeof sessionModule>, resolve: (value: typeof sessionModule) => void } {
  const gate = Promise.withResolvers<typeof sessionModule>()
  vi.mocked(loader.import).mockImplementation(async (id) => {
    if (id === '@deepseek-ai/dsh-llm')
      return llmModule
    if (id === '@deepseek-ai/dsh-session')
      return gate.promise
    throw new Error(`Unexpected public runtime import: ${id}`)
  })
  return gate
}

beforeEach(() => {
  context = new Context()
  sessions = new SessionStore(context)
  projections = new SessionProjectionRegistry(context)
  published = []
  context.on('session/event', (session, event) => published.push({ sessionId: session.id, event }))
  loader = {
    import: vi.fn(async (id) => {
      if (id === '@deepseek-ai/dsh-llm')
        return llmModule
      if (id === '@deepseek-ai/dsh-session')
        return sessionModule
      throw new Error(`Unexpected public runtime import: ${id}`)
    }),
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  vi.mocked(getServerContext).mockReturnValue(context)
})

afterEach(async () => {
  await context.fiber.dispose()
  vi.restoreAllMocks()
})

describe('official Alpha2 kernel identity writer', () => {
  it('loads the real public writer and reader exports through the host loader', async () => {
    const modules = await loadRuntimeModules(loader)
    expect(modules.appendPluginRecord).toBe(sessionModule.appendPluginRecord)
    expect(modules.pluginRecordOf).toBe(sessionModule.pluginRecordOf)
    expect(vi.mocked(loader.import).mock.calls).toEqual([['@deepseek-ai/dsh-llm'], ['@deepseek-ai/dsh-session']])
  })

  it.each(['codex', 'claude'] as const)('commits one complete ignorable %s record using the real attached Session store', async (backend) => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    const candidate: KernelBinding = { backend, nativeSessionId: `native-${backend}`, sessionId: 'session-a' }
    const changed = vi.fn()
    projections.onChanged(changed)
    expect(await identity.append(agentOf(session), candidate)).toBe(0)
    expect(session.seq).toBe(1)
    const [event] = eventsOf(session)
    expect(eventsOf(session)).toHaveLength(1)
    expect(event).toEqual({ type: 'plugin:dsh-tauri-bridge/kernel', seq: 0, time: expect.any(Number), data: { backend, nativeSessionId: `native-${backend}`, sessionId: 'session-a' }, ignorable: true })
    expect(sessionModule.pluginRecordOf(event)).toEqual({ type: 'plugin:dsh-tauri-bridge/kernel', seq: 0, time: event.time, data: candidate })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(identity.resolve(agentOf(session))).toEqual(candidate)
    expect(projections.snapshot(session)).toEqual({ asOfSeq: 0, values: { bridgeKernel: candidate } })
    expect(changed).toHaveBeenCalledExactlyOnceWith(session, 'bridgeKernel', candidate, 0)
    expect(session.deriveMessages()).toEqual([])
  })

  it('snapshots caller-owned binding input without freezing or retaining the mutable input object', async () => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    const candidate = { ...binding }
    await identity.append(agentOf(session), candidate)
    candidate.nativeSessionId = 'caller-edited'
    expect(candidate.nativeSessionId).toBe('caller-edited')
    expect(eventsOf(session)[0].data).toEqual(binding)
    expect(eventsOf(session)[0].data).not.toBe(candidate)
    expect(identity.resolve(agentOf(session))).toEqual(binding)
    expect(Object.isFrozen(projections.stateOf(session, 'bridgeKernel'))).toBe(true)
  })

  it('returns the current accepted watermark for duplicate identity without logging another record', async () => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    expect(await identity.append(agentOf(session), binding)).toBe(0)
    const state = projections.stateOf(session, 'bridgeKernel')
    session.append('turn/start', { turn: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const changed = vi.fn()
    projections.onChanged(changed)
    expect(await identity.append(agentOf(session), { ...binding })).toBe(2)
    expect(session.seq).toBe(3)
    expect(eventsOf(session).map(event => event.type)).toEqual(['plugin:dsh-tauri-bridge/kernel', 'turn/start', 'turn/end'])
    expect(projections.stateOf(session, 'bridgeKernel')).toBe(state)
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    { ...binding, backend: 'claude' as const },
    { ...binding, nativeSessionId: 'native-b' },
  ])('refuses replacing an already committed native identity before importing any writer: %j', async (different) => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    await identity.append(agentOf(session), binding)
    vi.mocked(loader.import).mockClear()
    await expect(identity.append(agentOf(session), different)).rejects.toThrow('BRIDGE_BINDING_IMMUTABLE: The official native kernel binding cannot be replaced')
    expect(loader.import).not.toHaveBeenCalled()
    expect(session.seq).toBe(1)
    expect(eventsOf(session)).toHaveLength(1)
    expect(identity.resolve(agentOf(session))).toEqual(binding)
  })

  it('rejects a foreign owner before a first native binding can enter the official log', async () => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    await expect(identity.append(agentOf(session), { ...binding, sessionId: 'session-other' })).rejects.toThrow('BRIDGE_INHERITED_SESSION: A native binding must belong to the exact official session')
    expect(loader.import).not.toHaveBeenCalled()
    expect(session.seq).toBe(0)
    expect(eventsOf(session)).toEqual([])
    expect(projections.stateOf(session, 'bridgeKernel')).toBeNull()
  })

  it('retains native identity in a real fork but refuses execution or rebinding for the child owner', async () => {
    identity.register()
    const parent = sessions.create(SessionId('session-a'))
    await identity.append(agentOf(parent), binding)
    const child = sessions.fork(parent, undefined, SessionId('session-child'))
    const before = child.seq
    expect(projections.stateOf(child, 'bridgeKernel')).toEqual(binding)
    expect(() => identity.resolve(agentOf(child))).toThrow('BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session')
    vi.mocked(loader.import).mockClear()
    await expect(identity.append(agentOf(child), { backend: 'codex', nativeSessionId: 'native-child', sessionId: 'session-child' })).rejects.toThrow('BRIDGE_BINDING_IMMUTABLE')
    expect(loader.import).not.toHaveBeenCalled()
    expect(child.seq).toBe(before)
    expect(identity.resolve(agentOf(parent))).toEqual(binding)
  })

  it('allows only the first conflicting binding after concurrently awaited runtime imports', async () => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    const gate = gateSessionImport()
    const results = Promise.allSettled([
      identity.append(agentOf(session), binding),
      identity.append(agentOf(session), { ...binding, nativeSessionId: 'native-second' }),
    ])
    expect(session.seq).toBe(0)
    expect(projections.stateOf(session, 'bridgeKernel')).toBeNull()
    gate.resolve(sessionModule)
    const [first, second] = await results
    expect(first).toEqual({ status: 'fulfilled', value: 0 })
    expect(second.status).toBe('rejected')
    if (second.status !== 'rejected')
      throw new Error('A conflicting concurrent identity write unexpectedly committed')
    expect(second.reason).toBeInstanceOf(Error)
    expect(second.reason.message).toBe('BRIDGE_BINDING_IMMUTABLE: The official native kernel binding cannot be replaced')
    expect(session.seq).toBe(1)
    expect(eventsOf(session)).toHaveLength(1)
    expect(identity.resolve(agentOf(session))).toEqual(binding)
  })

  it('deduplicates concurrently awaited identical bindings into one real log commit', async () => {
    identity.register()
    const session = sessions.create(SessionId('session-a'))
    const gate = gateSessionImport()
    const results = Promise.all([
      identity.append(agentOf(session), binding),
      identity.append(agentOf(session), { ...binding }),
    ])
    gate.resolve(sessionModule)
    expect(await results).toEqual([0, 0])
    expect(session.seq).toBe(1)
    expect(eventsOf(session)).toHaveLength(1)
    expect(projections.snapshot(session)).toEqual({ asOfSeq: 0, values: { bridgeKernel: binding } })
  })

  it('rechecks projection capability after awaited imports and refuses writes after unregister', async () => {
    const unregister = identity.register()
    const session = sessions.create(SessionId('session-a'))
    const gate = gateSessionImport()
    const pending = identity.append(agentOf(session), binding)
    const rejection = expect(pending).rejects.toThrow('BRIDGE_CORE_UNAVAILABLE: The official kernel projection was unregistered')
    unregister()
    gate.resolve(sessionModule)
    await rejection
    expect(session.seq).toBe(0)
    expect(eventsOf(session)).toEqual([])
    expect(projections.snapshot(session).values).toEqual({})
  })

  it('recovers exact identity from real written log bytes without consulting any backend catalog', async () => {
    identity.register()
    const original = sessions.create(SessionId('session-a'))
    await identity.append(agentOf(original), binding)
    const events: SessionEvent[] = JSON.parse(JSON.stringify(eventsOf(original)))
    const cold = Session.create(SessionId('session-a'), events, JSON.parse(JSON.stringify(original.header)), SessionLogOffset(0))
    vi.mocked(loader.import).mockClear()
    expect(identity.resolve(agentOf(cold))).toEqual(binding)
    expect(loader.import).not.toHaveBeenCalled()
    expect(Object.isFrozen(projections.stateOf(cold, 'bridgeKernel'))).toBe(true)
    expect(cold.deriveMessages()).toEqual([])
    expect(await identity.append(agentOf(cold), { ...binding })).toBe(cold.seq - 1)
    expect(cold.seq).toBe(events.length + 1)
    expect(eventsOf(original)).toHaveLength(1)
  })

  it('hydrates a usable detached checkpoint over real published events and freezes the canonical restored binding', async () => {
    identity.register()
    const original = sessions.create(SessionId('session-a'))
    await identity.append(agentOf(original), binding)
    original.append('turn/start', { turn: 0 })
    original.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const checkpoint = JSON.parse(JSON.stringify(projections.checkpoint(original)))
    const events: SessionEvent[] = JSON.parse(JSON.stringify(eventsOf(original)))
    expect(checkpoint.bridgeKernel).toEqual({ ver: 1, seq: 2, val: binding })
    expect(Object.isFrozen(checkpoint.bridgeKernel.val)).toBe(false)
    const cold = Session.create(SessionId('session-a'), events, JSON.parse(JSON.stringify(original.header)), SessionLogOffset(0))
    vi.mocked(loader.import).mockClear()
    expect(projections.hydrate(cold, checkpoint, events, SessionLogOffset(0))).toEqual({ asOfSeq: 2, values: { bridgeKernel: binding } })
    const state = projections.stateOf(cold, 'bridgeKernel')
    expect(Object.isFrozen(state)).toBe(true)
    expect(Reflect.set(state!, 'nativeSessionId', 'checkpoint-mutation')).toBe(false)
    expect(Object.isFrozen(projections.snapshot(cold).values.bridgeKernel)).toBe(true)
    expect(identity.resolve(agentOf(cold))).toEqual(binding)
    expect(loader.import).not.toHaveBeenCalled()
    expect(projections.viewCheckpoint(checkpoint)).toEqual({ bridgeKernel: binding })
  })
})
