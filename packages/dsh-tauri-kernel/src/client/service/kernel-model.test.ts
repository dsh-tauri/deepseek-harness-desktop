import type { StoredEntry } from 'dsh-tauri/client'
import type { NativeModelDirectory } from '../../shared/native-model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModels, postModels } from '../apis'
import { nativeModel } from '../store/modules/native-model'
import { canLockModelEntry, hasModelLockFace, loadNativeModels, selectNativeModel } from './kernel-model'
import { nativeModelDirectory } from './kernel-model.utils'

vi.mock('../apis', () => ({ getModels: vi.fn(), postModels: vi.fn() }))

const CATALOG: NativeModelDirectory = {
  backend: 'codex',
  defaultModel: 'gpt-5.4',
  current: { model: null, reasoningEffort: null },
  models: [{ id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } }],
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized promise')
  }
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function open(sessionId = 'session-a', scope = 1, catalog: NativeModelDirectory | null = CATALOG) {
  const current = { model: null, reasoningEffort: null }
  nativeModel.open({ sessionId, scope, backend: 'codex', nativeSessionId: 'native-a', request: 0, catalog, current, directory: nativeModelDirectory('codex', current, catalog) })
  return { sessionId, scope, active: () => true }
}

function entry(component = function ModelSelect() {}): StoredEntry {
  return { component, options: {}, locale: 'model', inject: () => ({}) }
}

function ThirdPartyModel() {}

function readIdentity() {}

function props(): Record<string, unknown> {
  return {
    locked: false,
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    load: () => {},
    select: async () => {},
    useProjection: readIdentity,
  }
}

beforeEach(() => {
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.mocked(getModels).mockReset().mockResolvedValue(CATALOG)
  vi.mocked(postModels).mockReset().mockResolvedValue({ model: 'gpt-5.4', reasoningEffort: 'high' })
})

afterEach(() => {
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.restoreAllMocks()
})

describe('official model capability', () => {
  it('recognizes only the verified named model renderer and its public injection', () => {
    expect(canLockModelEntry(entry())).toBe(true)
    expect(canLockModelEntry(entry(ThirdPartyModel))).toBe(false)
    expect(canLockModelEntry({ ...entry(), locale: 'settings.model' })).toBe(false)
    expect(canLockModelEntry({ ...entry(), inject: undefined })).toBe(false)
    expect(canLockModelEntry({ ...entry(), component: { $$typeof: Symbol.for('react.memo') } })).toBe(false)
  })

  it('requires the official locked owner and full observable directory business face', () => {
    expect(hasModelLockFace(props())).toBe(true)
    expect(hasModelLockFace(null)).toBe(false)
    for (const key of ['locked', 'available', 'load', 'select', 'useProjection', 'directory']) {
      const value = props()
      delete value[key]
      expect(hasModelLockFace(value)).toBe(false)
    }
    expect(hasModelLockFace({ ...props(), locked: 'true' })).toBe(false)
    expect(hasModelLockFace({ ...props(), directory: { getSnapshot: () => ({}) } })).toBe(false)
  })

  it('capability probes never invoke directory or session hooks', () => {
    const getSnapshot = vi.fn(() => ({}))
    const useProjection = vi.fn(() => null)
    expect(hasModelLockFace({ ...props(), directory: { subscribe: () => () => {}, getSnapshot }, useProjection })).toBe(true)
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(useProjection).not.toHaveBeenCalled()
  })
})

describe('native model actions', () => {
  it('loads the native-only directory and never replaces durable selection with a catalog hint', async () => {
    const scope = open('session-a', 1, null)
    nativeModel.update('session-a', 1, { current: { model: 'gpt-5.4', reasoningEffort: 'high' } })
    await loadNativeModels(scope)
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(nativeModel.$state.entries['session-a']?.directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(nativeModel.$state.entries['session-a']?.directory.status).toBe('ready')
    expect(postModels).not.toHaveBeenCalled()
  })

  it('submits the default-following model and exact depth then refreshes only the durable projection', async () => {
    const scope = open()
    const refreshProjection = vi.fn(async () => ({ model: 'gpt-5.4', reasoningEffort: 'high' }))
    expect(await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' }, refreshProjection })).toEqual({ ok: true, value: undefined })
    expect(postModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', model: null, reasoningEffort: 'high' })
    expect(refreshProjection).toHaveBeenCalledExactlyOnceWith('session-a')
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(nativeModel.$state.entries['session-a']?.directory.pending).toBeNull()
  })

  it('the single default model resets nullable preferences without persisting its displayed native baseline', async () => {
    const scope = open('session-a', 1, { ...CATALOG, defaultReasoningEffort: 'high' })
    const refreshProjection = vi.fn(async () => ({ model: null, reasoningEffort: null }))
    await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4' }, refreshProjection })
    expect(postModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', model: null, reasoningEffort: null })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
    expect(nativeModel.$state.entries['session-a']?.directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(refreshProjection).toHaveBeenCalledExactlyOnceWith('session-a')
  })

  it('backend changes and unsupported depths cannot issue a mutation', async () => {
    const scope = open()
    const refreshProjection = vi.fn(async () => ({ model: null, reasoningEffort: null }))
    expect(await selectNativeModel({ ...scope, selection: { provider: 'openai', model: 'gpt-5.4' }, refreshProjection })).toEqual({ ok: false, error: { code: 'bridge/model-selection', message: 'Native session kernel cannot be changed' } })
    expect(await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'max' }, refreshProjection })).toEqual({ ok: false, error: { code: 'bridge/model-selection', message: 'Native reasoning effort is unavailable' } })
    expect(postModels).not.toHaveBeenCalled()
    expect(refreshProjection).not.toHaveBeenCalled()
  })

  it('load failures stay visible and a retry can recover without changing native preferences', async () => {
    const scope = open()
    vi.mocked(getModels).mockRejectedValueOnce(new Error('CLI model catalog unavailable'))
    await loadNativeModels(scope)
    expect(nativeModel.$state.entries['session-a']?.directory).toMatchObject({ status: 'error', error: 'CLI model catalog unavailable', current: { provider: 'bridge/codex', model: 'gpt-5.4' } })
    await loadNativeModels(scope)
    expect(nativeModel.$state.entries['session-a']?.directory).toMatchObject({ status: 'ready', error: null })
  })

  it('a missing native conversation reports an actionable message instead of the raw server failure', async () => {
    const scope = open()
    vi.mocked(getModels).mockRejectedValueOnce(new Error('请求失败 (500): BRIDGE_NATIVE_TURN'))
    await loadNativeModels(scope)
    expect(nativeModel.$state.entries['session-a']?.directory).toMatchObject({ status: 'error', error: 'BRIDGE_SESSION_UNRECOVERABLE: 原生会话记录已不存在，请新建会话。', current: { provider: 'bridge/codex', model: 'gpt-5.4' } })
    await loadNativeModels(scope)
    expect(nativeModel.$state.entries['session-a']?.directory).toMatchObject({ status: 'ready', error: null })
  })

  it('catalog backend mismatch remains an error rather than making another kernel selectable', async () => {
    const scope = open()
    vi.mocked(getModels).mockResolvedValue({ ...CATALOG, backend: 'claude' })
    await loadNativeModels(scope)
    expect(nativeModel.$state.entries['session-a']?.directory.error).toBe('Native session kernel does not match the model catalog')
    expect(nativeModel.$state.entries['session-a']?.directory.groups[0]?.id).toBe('bridge/codex')
  })

  it('a failed POST preserves current options and exposes the actual retryable error', async () => {
    const scope = open()
    vi.mocked(postModels).mockRejectedValue(new Error('native session is busy'))
    const refreshProjection = vi.fn(async () => ({ model: null, reasoningEffort: null }))
    expect(await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4' }, refreshProjection })).toEqual({ ok: false, error: { code: 'bridge/model-selection', message: 'native session is busy' } })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
    expect(nativeModel.$state.entries['session-a']?.directory.pending).toBeNull()
    expect(refreshProjection).not.toHaveBeenCalled()
  })

  it('does not claim POST success if the official projection refresh fails', async () => {
    const scope = open()
    const refreshProjection = vi.fn(async () => {
      throw new Error('projection refresh failed')
    })
    expect(await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4' }, refreshProjection })).toEqual({ ok: false, error: { code: 'bridge/model-selection', message: 'projection refresh failed' } })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
  })

  it('superseded loads cannot overwrite a newer native catalog', async () => {
    const scope = open()
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...CATALOG, models: [{ id: 'gpt-next', name: 'Next' }] })
    const stale = loadNativeModels(scope)
    await loadNativeModels(scope)
    pending.resolve(CATALOG)
    await stale
    expect(nativeModel.$state.entries['session-a']?.catalog?.models).toEqual([{ id: 'gpt-next', name: 'Next' }])
  })

  it('a closed and reopened session cannot receive the previous load response', async () => {
    const scope = open()
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise)
    const stale = loadNativeModels(scope)
    nativeModel.close('session-a', 1)
    open('session-a', 2, null)
    pending.resolve(CATALOG)
    await stale
    expect(nativeModel.$state.entries['session-a']?.catalog).toBeNull()
    expect(nativeModel.$state.entries['session-a']?.directory.status).toBe('idle')
  })

  it('an inactive scope cannot start a GET or POST', async () => {
    const scope = { ...open(), active: () => false }
    await loadNativeModels(scope)
    expect(await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4' }, refreshProjection: vi.fn() })).toBeUndefined()
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it('a POST response after unmount cannot refresh projections or write to another session', async () => {
    const scope = open()
    open('session-b', 2, null)
    const pending = deferred<{ model: string | null, reasoningEffort: string | null }>()
    vi.mocked(postModels).mockReturnValue(pending.promise)
    const refreshProjection = vi.fn(async () => ({ model: 'gpt-5.4', reasoningEffort: 'high' }))
    const stale = selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4' }, refreshProjection })
    nativeModel.close('session-a', 1)
    pending.resolve({ model: 'gpt-5.4', reasoningEffort: null })
    expect(await stale).toBeUndefined()
    expect(refreshProjection).not.toHaveBeenCalled()
    expect(nativeModel.$state.entries['session-b']?.current).toEqual({ model: null, reasoningEffort: null })
  })

  it('an older selection cannot replace a newer successful native selection', async () => {
    const scope = open()
    const pending = deferred<{ model: string | null, reasoningEffort: string | null }>()
    vi.mocked(postModels).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ model: 'gpt-5.4', reasoningEffort: 'high' })
    const refreshProjection = vi.fn(async () => ({ model: 'gpt-5.4', reasoningEffort: 'high' }))
    const stale = selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'medium' }, refreshProjection })
    await selectNativeModel({ ...scope, selection: { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' }, refreshProjection })
    pending.resolve({ model: 'gpt-5.4', reasoningEffort: 'medium' })
    expect(await stale).toBeUndefined()
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(nativeModel.$state.entries['session-a']?.directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
  })
})
