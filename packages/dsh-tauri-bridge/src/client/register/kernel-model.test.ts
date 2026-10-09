import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { NativeModelActions } from '../types/kernel-model'
import { defineRegister } from 'dsh-tauri/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModels, postModels } from '../apis'
import { nativeModel } from '../store/modules/native-model'
import { registerNativeModels } from './kernel-model'

vi.mock('../apis', () => ({ getModels: vi.fn(), postModels: vi.fn() }))

const BINDING: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }
const CATALOG: NativeModelDirectory = {
  backend: 'codex',
  current: { model: null, reasoningEffort: null },
  defaultModel: 'gpt-5.4',
  models: [{ id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
}
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

function fixture(options: { list?: boolean, refresh?: boolean } = {}) {
  let state: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const refreshProjections = vi.fn(async (sessionId: string) => {
    state = { ...state, projectionsBySession: { ...state.projectionsBySession, [sessionId]: {
      values: { bridgeKernel: BINDING, bridgeModel: { model: 'gpt-5.4', reasoningEffort: 'high' } },
      state: 'ready',
      error: null,
    } } }
  })
  const sessions = {
    ...(options.list === false ? {} : { list: { subscribe: () => () => {}, getSnapshot: () => state } }),
    ...(options.refresh === false ? {} : { refreshProjections }),
    binding: vi.fn(),
    retain: vi.fn(),
    create: vi.fn(),
    selectModel: vi.fn(),
  }
  const navigation = { openSession: vi.fn(), startSession: vi.fn() }
  const ctx = { get: (name: string) => ({ sessions, uiWorkspace: navigation } as Record<string, unknown>)[name] }
  let actions: NativeModelActions | undefined
  const dispose = defineRegister(ctx, (controller, _ctx, adapter) => {
    actions = registerNativeModels(controller, adapter)
  })()
  disposers.push(dispose)
  if (actions === undefined)
    throw new Error('native model actions unavailable')
  return {
    actions,
    sessions,
    refreshProjections,
    navigation,
    dispose,
    setState(value: SessionListState) {
      state = value
    },
  }
}

beforeEach(() => {
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.mocked(getModels).mockReset().mockResolvedValue(CATALOG)
  vi.mocked(postModels).mockReset().mockResolvedValue({ model: 'gpt-5.4', reasoningEffort: 'high' })
})

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.restoreAllMocks()
})

describe('registered native model lifecycle', () => {
  it('requires both official list and nonactivating projection capabilities', () => {
    expect(fixture().actions.canSelectNativeModel()).toBe(true)
    expect(fixture({ list: false }).actions.canSelectNativeModel()).toBe(false)
    expect(fixture({ refresh: false }).actions.canSelectNativeModel()).toBe(false)
  })

  it('reference-counts the same native directory and closes it only after the last release', () => {
    const { actions } = fixture()
    const first = actions.acquireNativeModel('session-a', BINDING)
    const scope = nativeModel.$state.entries['session-a']?.scope
    const second = actions.acquireNativeModel('session-a', BINDING)
    expect(nativeModel.$state.entries['session-a']?.scope).toBe(scope)
    first()
    first()
    expect(nativeModel.$state.entries['session-a']).toBeDefined()
    second()
    expect(nativeModel.$state.entries['session-a']).toBeUndefined()
  })

  it('the public directory owns subscriptions, reads refreshed projection on reconnect, and rejects disposed listeners', async () => {
    const feature = fixture()
    const directory = feature.actions.createNativeModelDirectory('session-a', BINDING, { model: null, reasoningEffort: null })
    const first = directory.subscribe(vi.fn())
    await feature.refreshProjections('session-a')
    first()
    first()
    expect(nativeModel.$state.entries).toEqual({})
    const listener = vi.fn()
    const second = directory.subscribe(listener)
    expect(directory.getSnapshot().current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    feature.dispose()
    listener.mockClear()
    nativeModel.$patch({ generation: 99 })
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    directory.subscribe(listener)
    second()
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('syncs durable native options without issuing a request or using global model selection', () => {
    const { actions, sessions } = fixture()
    actions.acquireNativeModel('session-a', BINDING)
    actions.syncNativeModel('session-a', BINDING, { model: 'gpt-5.4', reasoningEffort: 'high' })
    const entry = nativeModel.$state.entries['session-a']
    actions.syncNativeModel('session-a', BINDING, { model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(nativeModel.$state.entries['session-a']).toBe(entry)
    expect(entry?.directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
    expect(sessions.selectModel).not.toHaveBeenCalled()
  })

  it('uses only generated native APIs and official projection refresh, never activation or global model RPC', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    await feature.actions.loadNativeModels('session-a', BINDING)
    expect(await feature.actions.selectNativeModel('session-a', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })).toEqual({ ok: true, value: undefined })
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(postModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(feature.refreshProjections).toHaveBeenCalledExactlyOnceWith('session-a')
    expect(feature.sessions.selectModel).not.toHaveBeenCalled()
    expect(feature.sessions.binding).not.toHaveBeenCalled()
    expect(feature.sessions.retain).not.toHaveBeenCalled()
    expect(feature.sessions.create).not.toHaveBeenCalled()
    expect(feature.navigation.openSession).not.toHaveBeenCalled()
    expect(feature.navigation.startSession).not.toHaveBeenCalled()
  })

  it('a forked parent identity cannot acquire a child directory or issue model requests', async () => {
    const { actions } = fixture()
    actions.acquireNativeModel('child-session', BINDING)
    actions.syncNativeModel('child-session', BINDING, { model: 'gpt-5.4', reasoningEffort: 'high' })
    await actions.loadNativeModels('child-session', BINDING)
    expect(await actions.selectNativeModel('child-session', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4' })).toBeUndefined()
    expect(nativeModel.$state.entries['child-session']).toBeUndefined()
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it('another native session identity cannot reuse an acquired lease', async () => {
    const { actions } = fixture()
    actions.acquireNativeModel('session-a', BINDING)
    const changed = { ...BINDING, nativeSessionId: 'native-b' }
    await actions.loadNativeModels('session-a', changed)
    expect(await actions.selectNativeModel('session-a', changed, { provider: 'bridge/codex', model: 'gpt-5.4' })).toBeUndefined()
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it('a binding replacement isolates its scope from the old release callback and response', async () => {
    const feature = fixture()
    const release = feature.actions.acquireNativeModel('session-a', BINDING)
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise)
    const stale = feature.actions.loadNativeModels('session-a', BINDING)
    feature.actions.acquireNativeModel('session-a', { ...BINDING, nativeSessionId: 'native-b' })
    release()
    pending.resolve(CATALOG)
    await stale
    expect(nativeModel.$state.entries['session-a']?.nativeSessionId).toBe('native-b')
    expect(nativeModel.$state.entries['session-a']?.catalog).toBeNull()
  })

  it('plugin disposal removes transient directories and blocks retained UI callbacks', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    feature.dispose()
    expect(feature.actions.canSelectNativeModel()).toBe(false)
    feature.actions.acquireNativeModel('session-a', BINDING)
    feature.actions.syncNativeModel('session-a', BINDING, { model: 'gpt-5.4', reasoningEffort: 'high' })
    await feature.actions.loadNativeModels('session-a', BINDING)
    expect(await feature.actions.selectNativeModel('session-a', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4' })).toBeUndefined()
    expect(nativeModel.$state.entries).toEqual({})
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it('a pending GET cannot resurrect a disposed directory', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise)
    const stale = feature.actions.loadNativeModels('session-a', BINDING)
    feature.dispose()
    pending.resolve(CATALOG)
    await stale
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('a pending POST cannot refresh or mutate after plugin disposal', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    await feature.actions.loadNativeModels('session-a', BINDING)
    const pending = deferred<NativeTurnOptions>()
    vi.mocked(postModels).mockReturnValueOnce(pending.promise)
    const stale = feature.actions.selectNativeModel('session-a', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4' })
    feature.dispose()
    pending.resolve({ model: 'gpt-5.4', reasoningEffort: null })
    expect(await stale).toBeUndefined()
    expect(feature.refreshProjections).not.toHaveBeenCalled()
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('a refreshed projection with a different kernel cannot be accepted as selection success', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    await feature.actions.loadNativeModels('session-a', BINDING)
    feature.refreshProjections.mockImplementation(async () => {
      feature.setState({ ids: [], byId: {}, phase: 'ready', projectionsBySession: { ['session-a' as SessionId]: {
        values: { bridgeKernel: { ...BINDING, nativeSessionId: 'native-other' }, bridgeModel: { model: 'gpt-5.4', reasoningEffort: 'high' } },
        state: 'ready',
        error: null,
      } } })
    })
    expect(await feature.actions.selectNativeModel('session-a', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4' })).toEqual({ ok: false, error: { code: 'bridge/model-selection', message: 'Native model selection projection is unavailable' } })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
  })

  it('disposal during projection refresh cannot install the returned preference', async () => {
    const feature = fixture()
    feature.actions.acquireNativeModel('session-a', BINDING)
    await feature.actions.loadNativeModels('session-a', BINDING)
    const pending = deferred<void>()
    feature.refreshProjections.mockReturnValueOnce(pending.promise)
    const stale = feature.actions.selectNativeModel('session-a', BINDING, { provider: 'bridge/codex', model: 'gpt-5.4' })
    await vi.waitFor(() => expect(feature.refreshProjections).toHaveBeenCalledOnce())
    feature.dispose()
    pending.resolve()
    expect(await stale).toBeUndefined()
    expect(nativeModel.$state.entries).toEqual({})
  })
})
