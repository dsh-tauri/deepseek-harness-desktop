import type { SchedulerUiState } from './scheduler.types'
import { defineStore } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../../shared/constants'

export const scheduler = defineStore({
  state: (): SchedulerUiState => ({
    tasks: [],
    runs: [],
    options: { workspaces: [], permissions: [], defaultPermission: 'read-only', models: [], failures: [], defaultModel: null },
    loading: false,
    error: '',
    refreshedAt: 0,
    loadToken: 0,
    successfulReadToken: 0,
    readAt: 0,
    readIds: [],
  }),
  persist: { key: `${PLUGIN_ID}.read`, paths: ['readAt', 'readIds'] },
  actions: {
    seedReadAt() {
      if (this.readAt !== 0)
        return
      this.readAt = Date.now()
    },
    markRunRead(id: string) {
      if (this.readIds.includes(id))
        return
      this.readIds = [...this.readIds, id]
    },
    markSessionRead(sessionId: string) {
      const next = [...new Set([
        ...this.readIds,
        ...this.runs.filter(run => run.sessionId === sessionId).map(run => run.id),
      ])]
      if (next.length === this.readIds.length)
        return
      this.readIds = next
    },
    markAllRunsRead() {
      this.readAt = Date.now()
      this.readIds = []
    },
  },
})
