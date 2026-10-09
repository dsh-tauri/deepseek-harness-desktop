import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { StoredEntry } from 'dsh-tauri/client'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { NativeModelOutcome, NativeModelScope, OfficialModelSelectFace } from '../types/kernel-model'
import { getModels, postModels } from '../apis'
import { nativeModel } from '../store/modules/native-model'
import { nativeModelDirectory, nativeModelOptions } from './kernel-model.utils'

export function canLockModelEntry(entry: StoredEntry): boolean {
  return entry.locale === 'model'
    && typeof entry.component === 'function' && entry.component.name === 'ModelSelect'
    && typeof entry.inject === 'function'
}

export function hasModelLockFace(value: unknown): value is OfficialModelSelectFace {
  if (typeof value !== 'object' || value === null)
    return false
  const props = value as Record<string, unknown>
  const directory = props.directory
  return typeof props.locked === 'boolean' && typeof props.available === 'boolean'
    && typeof props.load === 'function' && typeof props.select === 'function'
    && typeof directory === 'object' && directory !== null
    && 'subscribe' in directory && typeof directory.subscribe === 'function'
    && 'getSnapshot' in directory && typeof directory.getSnapshot === 'function'
    && typeof props.useProjection === 'function'
}

export async function loadNativeModels(scope: NativeModelScope): Promise<NativeModelDirectory | undefined> {
  const entry = nativeModel.$state.entries[scope.sessionId]
  if (!scope.active() || entry?.scope !== scope.scope)
    return undefined
  const request = entry.request + 1
  nativeModel.update(scope.sessionId, scope.scope, { request, directory: { ...entry.directory, status: 'loading', error: null } })
  const current = (): boolean => scope.active() && nativeModel.$state.entries[scope.sessionId]?.scope === scope.scope
    && nativeModel.$state.entries[scope.sessionId]?.request === request
  try {
    const catalog = await getModels({ sessionId: scope.sessionId })
    if (!current())
      return undefined
    if (catalog.backend !== entry.backend)
      throw new Error('Native session kernel does not match the model catalog')
    const latest = nativeModel.$state.entries[scope.sessionId]!
    const directory = nativeModelDirectory(entry.backend, latest.current, catalog)
    nativeModel.update(scope.sessionId, scope.scope, { catalog, directory: { ...directory, status: 'ready' } })
    return catalog
  }
  catch (reason) {
    if (current()) {
      const latest = nativeModel.$state.entries[scope.sessionId]!
      nativeModel.update(scope.sessionId, scope.scope, {
        directory: { ...latest.directory, status: 'error', error: reason instanceof Error ? reason.message : String(reason) },
      })
    }
    return undefined
  }
}

export async function selectNativeModel(input: NativeModelScope & {
  selection: ModelSelection
  refreshProjection: (sessionId: string) => Promise<NativeTurnOptions>
}): Promise<NativeModelOutcome | undefined> {
  const entry = nativeModel.$state.entries[input.sessionId]
  if (!input.active() || entry?.scope !== input.scope)
    return undefined
  const request = entry.request + 1
  const current = (): boolean => input.active() && nativeModel.$state.entries[input.sessionId]?.scope === input.scope
    && nativeModel.$state.entries[input.sessionId]?.request === request
  nativeModel.update(input.sessionId, input.scope, { request, directory: { ...entry.directory, status: 'selecting', pending: input.selection, error: null } })
  try {
    if (entry.catalog === null)
      throw new Error('Native model catalog is unavailable; reload models')
    const options = nativeModelOptions(entry.backend, entry.catalog, input.selection)
    await postModels({ sessionId: input.sessionId, ...options })
    if (!current())
      return undefined
    const projected = await input.refreshProjection(input.sessionId)
    if (!current())
      return undefined
    const latest = nativeModel.$state.entries[input.sessionId]!
    const directory = nativeModelDirectory(entry.backend, projected, latest.catalog)
    nativeModel.update(input.sessionId, input.scope, { current: projected, directory: { ...directory, status: 'ready' } })
    return { ok: true, value: undefined }
  }
  catch (reason) {
    if (!current())
      return undefined
    const message = reason instanceof Error ? reason.message : String(reason)
    const latest = nativeModel.$state.entries[input.sessionId]!
    nativeModel.update(input.sessionId, input.scope, {
      directory: { ...latest.directory, status: 'error', pending: null, error: message },
    })
    return { ok: false, error: { code: 'bridge/model-selection', message } }
  }
}
