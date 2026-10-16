import type { SyncItemResult, SyncPreview } from '../../types/index'

export type SyncStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SyncState {
  status: SyncStatus
  error: string | null
  preview: SyncPreview | null
  applying: boolean
  results: SyncItemResult[] | null
}
