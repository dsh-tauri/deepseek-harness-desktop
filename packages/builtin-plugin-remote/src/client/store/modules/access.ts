import type { AccessStatus } from '../../types/index'
import type { AccessViewState } from './access.types'
import { defineStore } from 'dsh-tauri/client'

function initialState(): AccessViewState {
  return {
    status: 'idle',
    error: null,
    busy: false,
    requestSeq: 0,
    savedSeq: 0,
    snapshot: null,
  }
}

export const access = defineStore({
  state: (): AccessViewState => initialState(),
  actions: {
    reset(): void {
      const seq = this.requestSeq + 1
      Object.assign(this, initialState(), { requestSeq: seq, savedSeq: seq })
    },
    beginRequest(): number {
      return ++this.requestSeq
    },
    invalidateRequests(): number {
      this.savedSeq = ++this.requestSeq
      return this.savedSeq
    },
    beginLoad(): void {
      this.status = 'loading'
      this.error = null
    },
    commit(snapshot: AccessStatus, seq?: number): void {
      const savedSeq = seq ?? this.requestSeq
      if (savedSeq < this.savedSeq)
        return
      this.savedSeq = savedSeq
      this.snapshot = snapshot
      this.status = 'ready'
      this.error = null
    },
    fail(message: string, seq?: number): void {
      const savedSeq = seq ?? this.requestSeq
      if (savedSeq < this.savedSeq)
        return
      this.savedSeq = savedSeq
      this.status = 'error'
      this.error = message
    },
    beginBusy(): void {
      this.busy = true
    },
    endBusy(): void {
      this.busy = false
    },
  },
})
