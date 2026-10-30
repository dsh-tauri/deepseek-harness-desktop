import type { WorktreeSessionState, WorktreeUiState } from './worktree.types'
import { defineStore } from 'dsh-tauri/client'
import { EMPTY_SESSION_STATE } from './worktree.utils'

export const worktree = defineStore({
  state: (): WorktreeUiState => ({ bySession: {} }),
  actions: {
    patch(sessionId: string | undefined, patch: Partial<WorktreeSessionState>): void {
      if (sessionId === undefined)
        return
      this.bySession[sessionId] = { ...(this.bySession[sessionId] ?? EMPTY_SESSION_STATE), ...patch }
    },
  },
})
