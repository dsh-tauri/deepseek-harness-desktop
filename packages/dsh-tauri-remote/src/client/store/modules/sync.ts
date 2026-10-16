import type { SyncItemResult, SyncPreview } from '../../types/index'
import type { SyncState } from './sync.types'
import { defineStore } from 'dsh-tauri/client'
import { mergeSyncResults } from './sync.utils'

function initialState(): SyncState {
  return { status: 'idle', error: null, preview: null, applying: false, results: null }
}

export const sync = defineStore({
  state: (): SyncState => initialState(),
  actions: {
    reset(): void {
      Object.assign(this, initialState())
    },
    beginLoad(): void {
      this.status = 'loading'
      this.error = null
    },
    commitPreview(preview: SyncPreview): void {
      this.preview = preview
      this.status = 'ready'
      this.error = null
    },
    failLoad(error: string): void {
      this.status = 'error'
      this.error = error
    },
    fail(error: string): void {
      this.error = error
    },
    beginApply(): void {
      this.applying = true
      this.error = null
    },
    endApply(): void {
      this.applying = false
    },
    mergeResults(items: SyncItemResult[]): void {
      this.results = mergeSyncResults(this.results ?? [], items)
    },
  },
})
