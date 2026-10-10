import type { NativeModelEntry } from '../../types/kernel-model'
import { defineStore } from 'dsh-tauri/client'

export const nativeModel = defineStore({
  state: () => ({ generation: 0, entries: {} as Record<string, NativeModelEntry | undefined> }),
  actions: {
    nextScope() {
      return ++this.generation
    },
    open(entry: NativeModelEntry) {
      this.entries[entry.sessionId] = entry
    },
    update(sessionId: string, scope: number, patch: Partial<NativeModelEntry>) {
      const entry = this.entries[sessionId]
      if (entry?.scope === scope)
        this.entries[sessionId] = { ...entry, ...patch }
    },
    close(sessionId: string, scope: number) {
      if (this.entries[sessionId]?.scope === scope)
        delete this.entries[sessionId]
    },
  },
})
