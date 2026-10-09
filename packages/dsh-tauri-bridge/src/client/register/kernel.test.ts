import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { ComponentType } from 'react'
import type { BackendDetection, KernelBinding } from '../../shared/types'
import type { KernelActions } from '../components/slot-contract'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBackends, postSessions } from '../apis'
import { kernelStore } from '../store/modules/kernel-store'
import { kernel } from './kernel'

vi.hoisted(() => vi.stubGlobal('localStorage', undefined))
vi.mock('../apis', () => ({ getBackends: vi.fn(), postSessions: vi.fn(), getModels: vi.fn(), postModels: vi.fn() }))
vi.mock('dsh-tauri-ui/client', async () => ({ ...await import('../../../../dsh-tauri-ui/src/client/register/slot-decoration') }))
vi.mock('../components/hero-kernel', () => ({ HeroKernel: () => null }))
vi.mock('../components/model-kernel', () => ({ ModelKernel: () => null }))
vi.mock('../components/session-kernel', () => ({ SessionKernel: () => null }))
vi.mock('../components/session-kernel-hover', () => ({ SessionKernelHover: () => null }))

const BACKENDS: BackendDetection[] = [
  { id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null },
  { id: 'codex', installed: true, auth: 'ok', version: '1.0', drift: false, hint: null },
  { id: 'claude', installed: false, auth: 'unknown', version: null, drift: false, hint: null },
]
const BINDING: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'new-session' }
const disposers: (() => void)[] = []

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized promise')
  }
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function fixture(options: { hero?: boolean, sidebar?: boolean, hover?: boolean, model?: boolean, unknownModel?: boolean, refresh?: boolean, create?: boolean, open?: boolean } = {}) {
  const core = new SlotCore()
  const register = core.register.bind(core) as unknown as (registration: Record<string, unknown>, component: ComponentType<Record<string, unknown>>) => () => void
  register({ name: 'root', children: {
    ...(options.hero === false ? {} : { 'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' } }),
    ...(options.sidebar === false ? {} : { 'sidebar.session.row.leading': { kind: 'list', scope: 'root' } }),
    ...(options.hover === false ? {} : { 'sidebar.session.row.hover': { kind: 'list', scope: 'root' } }),
    ...(options.model === true ? { 'conversation.input.model': { kind: 'single', scope: 'session' } } : {}),
  } }, () => null)
  if (options.hero !== false)
    register({ name: 'conversation.hero.agentPreset', locale: 'settings.agentPreset' }, () => null)
  function ModelSelect() {
    return null
  }
  function UnknownModel() {
    return null
  }
  if (options.model === true)
    register({ name: 'conversation.input.model', locale: 'model', inject: () => ({}) }, options.unknownModel === true ? UnknownModel : ModelSelect)
  let state: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const openSession = vi.fn()
  const startSession = vi.fn()
  const officialCreate = vi.fn(async () => 'official-new')
  const refreshProjections = vi.fn(async (sessionId: string) => {
    const id = sessionId as SessionId
    state = {
      ...state,
      projectionsBySession: { [id]: { values: { bridgeKernel: { ...BINDING, sessionId } }, state: 'ready', error: null } },
    }
  })
  const sessions: Record<string, unknown> = {
    ...(options.create === false ? {} : { create: officialCreate }),
    list: { getSnapshot: () => state, subscribe: () => () => {} },
    refresh: vi.fn(async () => {}),
    ...(options.refresh === false ? {} : { refreshProjections }),
    binding: vi.fn(),
    retain: vi.fn(),
  }
  const uiWorkspace = { ...(options.open === false ? {} : { openSession }), startSession }
  const navigation = new AbortController()
  const beginNavigation = vi.fn(() => navigation.signal)
  const slotDisposers: ReturnType<typeof vi.fn>[] = []
  const slots = {
    spec: core.spec.bind(core),
    entries: core.entries.bind(core),
    entriesOfSlot: core.entriesOfSlot.bind(core),
    subscribe: core.subscribe.bind(core),
    onEntryError: core.onEntryError.bind(core),
    register: vi.fn(register),
    inject: vi.fn((key: string, setup: () => (() => void) | Iterable<() => void>) => {
      let cleanups: (() => void)[] = []
      function clear(): void {
        for (const dispose of cleanups.splice(0).reverse())
          dispose()
      }
      function sync(): void {
        clear()
        if (core.specDynamic(key) !== undefined) {
          const effect = setup()
          cleanups = typeof effect === 'function' ? [effect] : [...effect]
        }
      }
      const unsubscribe = core.subscribeDeclaration(key, sync)
      sync()
      const dispose = vi.fn(() => {
        unsubscribe()
        clear()
      })
      slotDisposers.push(dispose)
      return dispose
    }),
  }
  const ctx = {
    sessions,
    slots,
    layout: { beginNavigation },
    get(name: string): unknown {
      return ({ sessions, slots, uiWorkspace, layout: this.layout } as Record<string, unknown>)[name]
    },
  }
  const dispose = kernel.call({ ctx })
  disposers.push(dispose)
  function hero(): KernelActions {
    const entry = core.entriesOfSlot('conversation.hero.agentPreset')[0]
    const read = entry?.inject as (() => KernelActions) | undefined
    if (read === undefined)
      throw new Error('hero kernel actions unavailable')
    return read()
  }
  function sidebar(key = 'sidebar.session.row.leading'): Pick<KernelActions, 'ensureProjection'> {
    const entry = core.entriesOfSlot(key)[0]
    const read = entry?.inject as (() => Pick<KernelActions, 'ensureProjection'>) | undefined
    if (read === undefined)
      throw new Error('sidebar kernel actions unavailable')
    return read()
  }
  return { core, slots, ctx, sessions, uiWorkspace, navigation, beginNavigation, officialCreate, openSession, refreshProjections, slotDisposers, hero, sidebar, dispose }
}

beforeEach(() => {
  kernelStore.$patch({ selected: 'dsh', phase: 'idle', backends: [], error: null })
  vi.mocked(getBackends).mockReset().mockResolvedValue(BACKENDS)
  vi.mocked(postSessions).mockReset().mockResolvedValue({ sessionId: 'new-session' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  kernelStore.$patch({ selected: 'dsh', phase: 'idle', backends: [], error: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', undefined)
})

afterAll(() => vi.unstubAllGlobals())

describe('kernel registration and lifecycle', () => {
  it('decorates the terminal official hero and adds distinct ordered leading and hover list entries without activating sessions', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    expect(feature.slots.register.mock.calls.map(([entry]) => ({ name: entry.name, id: entry.id, order: entry.order }))).toEqual([
      { name: 'conversation.hero.agentPreset', id: undefined, order: undefined },
      { name: 'sidebar.session.row.leading', id: 'dsh-tauri-bridge:kernel', order: -10 },
      { name: 'sidebar.session.row.hover', id: 'dsh-tauri-bridge:kernel', order: -10 },
    ])
    expect(feature.openSession).not.toHaveBeenCalled()
    expect(feature.sessions.binding).not.toHaveBeenCalled()
    expect(feature.sessions.retain).not.toHaveBeenCalled()
    expect(feature.refreshProjections).not.toHaveBeenCalled()
    expect(Object.keys(feature.uiWorkspace)).toEqual(['openSession', 'startSession'])
    feature.dispose()
    expect(feature.core.entries('conversation.hero.agentPreset')).toHaveLength(1)
    expect(feature.core.entries('sidebar.session.row.leading')).toEqual([])
    expect(feature.core.entries('sidebar.session.row.hover')).toEqual([])
    for (const dispose of feature.slotDisposers)
      expect(dispose).toHaveBeenCalledOnce()
  })

  it('wraps the verified official model seat and restores it on plugin disposal', async () => {
    const feature = fixture({ model: true })
    await Promise.resolve()
    const entry = feature.core.entriesOfSlot('conversation.input.model')[0]
    expect(entry?.registrant).toBe('dsh-tauri-bridge')
    expect(entry?.options.priority).toBe(-1)
    expect(entry?.locale).toBe('model')
    expect(feature.core.entries('conversation.input.model')).toHaveLength(2)
    feature.dispose()
    await Promise.resolve()
    expect(feature.core.entries('conversation.input.model')).toHaveLength(1)
    expect((feature.core.entriesOfSlot('conversation.input.model')[0]?.component as ComponentType)?.name).toBe('ModelSelect')
    expect(feature.openSession).not.toHaveBeenCalled()
  })

  it('an unknown model renderer stays unchanged without claiming disabled support', async () => {
    const feature = fixture({ model: true, unknownModel: true })
    await Promise.resolve()
    expect(feature.core.entries('conversation.input.model')).toHaveLength(1)
    expect((feature.core.entriesOfSlot('conversation.input.model')[0]?.component as ComponentType)?.name).toBe('UnknownModel')
    expect(console.warn).toHaveBeenCalledWith('[dsh-tauri-bridge] slot decoration unavailable; the official renderer capability is unverified', undefined)
    expect(feature.openSession).not.toHaveBeenCalled()
  })

  it('missing public slot declarations do not invent a slot or alter the official navigator', async () => {
    const feature = fixture({ hero: false, sidebar: false, hover: false })
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    expect(feature.slots.register).not.toHaveBeenCalled()
    expect(feature.core.snapshot().map(item => item.name)).toEqual(['root'])
    expect(Object.keys(feature.uiWorkspace)).toEqual(['openSession', 'startSession'])
    expect(postSessions).not.toHaveBeenCalled()
    expect(feature.officialCreate).not.toHaveBeenCalled()
  })

  it('missing official projection capability renders disabled creation rather than inventing a runtime method', async () => {
    const feature = fixture({ refresh: false })
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    expect(feature.hero().canCreate()).toBe(false)
    await expect(feature.hero().createSession('codex', {})).rejects.toThrow('capabilities are unavailable')
    expect(postSessions).not.toHaveBeenCalled()
  })

  it('explicit native selection opens a fresh verified session through the official navigator and remembers only the picker choice', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    await feature.hero().createSession('codex', { workspaceId: 'workspace-a' }, 'coding')
    expect(postSessions).toHaveBeenCalledWith({ backend: 'codex', workspaceId: 'workspace-a', agentPreset: 'coding' })
    expect(feature.beginNavigation).toHaveBeenCalledOnce()
    expect(feature.openSession).toHaveBeenCalledWith('new-session')
    expect(feature.officialCreate).not.toHaveBeenCalled()
    expect(feature.uiWorkspace.startSession).not.toHaveBeenCalled()
    expect(kernelStore.$state.selected).toBe('codex')
  })

  it('explicit DeepSeek selection creates fresh rather than rebinding or reusing the current native session', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    kernelStore.select('codex')
    await feature.hero().createSession('dsh', { cwd: '/ungrouped' })
    expect(feature.officialCreate).toHaveBeenCalledWith({ cwd: '/ungrouped' })
    expect(postSessions).not.toHaveBeenCalled()
    expect(feature.openSession).toHaveBeenCalledWith('official-new')
    expect(kernelStore.$state.selected).toBe('dsh')
  })

  it('navigation cancellation leaves a completed creation unopened and does not save its picker choice', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    const pending = deferred<{ sessionId: string }>()
    vi.mocked(postSessions).mockReturnValue(pending.promise)
    const task = feature.hero().createSession('codex', {})
    feature.navigation.abort()
    pending.resolve({ sessionId: 'new-session' })
    await task
    expect(feature.openSession).not.toHaveBeenCalled()
    expect(kernelStore.$state.selected).toBe('dsh')
  })

  it('plugin disposal during an HTTP create prevents refresh, official opening, and preference writes', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    const pending = deferred<{ sessionId: string }>()
    vi.mocked(postSessions).mockReturnValue(pending.promise)
    const task = feature.hero().createSession('codex', {})
    feature.dispose()
    pending.resolve({ sessionId: 'new-session' })
    await expect(task).rejects.toThrow('creation was cancelled')
    expect(feature.sessions.refresh).not.toHaveBeenCalled()
    expect(feature.refreshProjections).not.toHaveBeenCalled()
    expect(feature.openSession).not.toHaveBeenCalled()
    expect(kernelStore.$state.selected).toBe('dsh')
  })

  it('a detection response arriving after disposal cannot update the shared store', async () => {
    const pending = deferred<BackendDetection[]>()
    vi.mocked(getBackends).mockReturnValue(pending.promise)
    const feature = fixture()
    feature.dispose()
    kernelStore.$patch({ phase: 'idle', backends: [], error: null })
    pending.resolve(BACKENDS)
    await pending.promise
    await Promise.resolve()
    expect(kernelStore.$state.phase).toBe('idle')
    expect(kernelStore.$state.backends).toEqual([])
  })

  it('a superseded detection response cannot overwrite the newer roster', async () => {
    const pending = deferred<BackendDetection[]>()
    vi.mocked(getBackends).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([BACKENDS[0]!])
    const feature = fixture()
    await feature.hero().refreshBackends()
    pending.resolve(BACKENDS)
    await pending.promise
    await Promise.resolve()
    expect(kernelStore.$state.backends).toEqual([{ id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null }])
    expect(kernelStore.$state.phase).toBe('ready')
  })

  it('leading and hover identities invoke only the nonactivating official projection refresh', async () => {
    const feature = fixture()
    await feature.sidebar().ensureProjection('archived-session')
    await feature.sidebar('sidebar.session.row.hover').ensureProjection('blank-session')
    expect(feature.refreshProjections.mock.calls).toEqual([['archived-session'], ['blank-session']])
    expect(feature.sessions.binding).not.toHaveBeenCalled()
    expect(feature.sessions.retain).not.toHaveBeenCalled()
    expect(feature.openSession).not.toHaveBeenCalled()
    expect(postSessions).not.toHaveBeenCalled()
  })

  it('a resolved projection read with no kernel key warns once and never assumes a DeepSeek identity', async () => {
    const feature = fixture()
    feature.refreshProjections.mockImplementation(async () => {})
    await feature.sidebar().ensureProjection('archived-session')
    await feature.sidebar().ensureProjection('archived-session')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('[dsh-tauri-bridge] session kernel identity unavailable: archived-session', undefined)
    expect(feature.openSession).not.toHaveBeenCalled()
  })

  it('disposed UI callbacks cannot start detection or projection work', async () => {
    const feature = fixture()
    await vi.waitFor(() => expect(kernelStore.$state.phase).toBe('ready'))
    const actions = feature.hero()
    feature.dispose()
    vi.mocked(getBackends).mockClear()
    kernelStore.$patch({ phase: 'idle', backends: [] })
    await actions.refreshBackends()
    await actions.ensureProjection('archived-session')
    expect(getBackends).not.toHaveBeenCalled()
    expect(feature.refreshProjections).not.toHaveBeenCalled()
    expect(kernelStore.$state.phase).toBe('idle')
  })

  it('an unavailable projection reader warns once without treating the session as DeepSeek', async () => {
    const feature = fixture({ refresh: false })
    await feature.sidebar().ensureProjection('archived-session')
    await feature.sidebar().ensureProjection('archived-session')
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('[dsh-tauri-bridge] sessions.refreshProjections unavailable; session kernel identity is unknown', undefined)
    expect(feature.openSession).not.toHaveBeenCalled()
  })
})
