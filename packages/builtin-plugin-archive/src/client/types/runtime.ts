import type {
  ISessions,
  IWorkspaces,
  SessionListState,
  SessionSummary,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceView,
} from 'dsh-tauri/client'

export type SessionSummaryLike = SessionSummary
export type WorkspaceViewLike = WorkspaceView

export type SessionListSnapshot = Omit<SessionListState, 'ids' | 'byId' | 'current'> & {
  ids: string[]
  byId: Record<string, SessionSummary>
  current?: string
}

export type WorkspaceListSnapshot = Pick<WorkspaceSnapshot, 'items' | 'archivedSessionIds'>

export type SessionsRuntimeLike = Pick<ISessions, 'list' | 'refresh' | 'binding' | 'fork'> & {
  open?: (sessionId: string) => unknown
}

export type WorkspacesRuntimeLike = Pick<IWorkspaces, 'list' | 'archiveSession' | 'delete'> & {
  manager?: { refresh?: () => Promise<void> }
  startSession?: (workspaceId: WorkspaceId) => void
}
