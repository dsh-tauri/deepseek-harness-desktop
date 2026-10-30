import type { WorktreeSessionView } from '../store/modules/worktree.types'
import { useStore } from 'dsh-tauri/client'
import { store } from '../store'
import { EMPTY_SESSION_STATE } from '../store/modules/worktree.utils'

export function useWorktreeSession(sessionId: string | undefined): WorktreeSessionView {
  const { bySession } = useStore(store.worktree)
  if (sessionId === undefined)
    return EMPTY_SESSION_STATE
  return bySession[sessionId] ?? EMPTY_SESSION_STATE
}
