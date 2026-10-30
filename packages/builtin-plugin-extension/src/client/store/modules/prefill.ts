import type { PrefillState } from './prefill.types'
import { defineStore, remove, uniq } from 'dsh-tauri/client'

export const prefill = defineStore({
  state: (): PrefillState => ({ pendingSessionIds: [] }),
  actions: {
    add(sessionId: string) {
      this.pendingSessionIds = uniq([...this.pendingSessionIds, sessionId])
    },
    consume(sessionId: string): boolean {
      return remove(this.pendingSessionIds, id => id === sessionId).length > 0
    },
    clear() {
      this.pendingSessionIds = []
    },
  },
})
