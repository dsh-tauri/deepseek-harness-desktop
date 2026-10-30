import type { SessionId, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'

export type SessionLinkState = 'available' | 'loading' | 'archived' | 'unavailable'

export function sessionLinkState(id: string, sessions: SessionListState, workspaces: WorkspaceSnapshot): SessionLinkState {
  if (workspaces.state === 'error')
    return 'unavailable'
  if (sessions.phase === 'pending' || workspaces.phase === 'pending')
    return 'loading'
  if (workspaces.archivedSessionIds.includes(id as SessionId))
    return 'archived'
  if (!sessions.ids.includes(id as SessionId))
    return 'unavailable'
  return 'available'
}

export function sessionLabel(id: string, sessions: SessionListState): { text: string, titled: boolean } {
  const title = sessions.byId[id as SessionId]?.title
  return title?.trim() ? { text: title, titled: true } : { text: id, titled: false }
}
