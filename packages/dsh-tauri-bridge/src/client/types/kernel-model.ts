import type { ModelCatalogFailure, ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'

export interface OfficialModelSelectFace {
  locked: boolean
  available: boolean
  directory: { subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown }
  load: () => void
  select: (selection: ModelSelection) => Promise<unknown>
}

export interface NativeModelDirectoryState {
  current: ModelSelection | null
  retainedEffort?: string
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  pending: ModelSelection | null
  error: string | null
}

export interface NativeModelEntry {
  scope: number
  sessionId: string
  backend: KernelBinding['backend']
  nativeSessionId: string
  request: number
  catalog: NativeModelDirectory | null
  current: NativeTurnOptions
  directory: NativeModelDirectoryState
}

export interface NativeModelScope {
  sessionId: string
  scope: number
  active: () => boolean
}

export type NativeModelOutcome = { ok: true, value: undefined } | { ok: false, error: { code: string, message: string } }

export interface NativeModelActions {
  canSelectNativeModel: () => boolean
  createNativeModelDirectory: (sessionId: string, binding: KernelBinding, current: NativeTurnOptions) => {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => NativeModelDirectoryState
  }
  acquireNativeModel: (sessionId: string, binding: KernelBinding) => () => void
  syncNativeModel: (sessionId: string, binding: KernelBinding, current: NativeTurnOptions) => void
  loadNativeModels: (sessionId: string, binding: KernelBinding) => Promise<void>
  selectNativeModel: (sessionId: string, binding: KernelBinding, selection: ModelSelection) => Promise<NativeModelOutcome | undefined>
}
