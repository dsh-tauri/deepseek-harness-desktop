import type {
  ISessions,
  IWorkspaces,
  SessionId,
  SessionListState,
  SessionSummary,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceView,
} from 'dsh-tauri/client'

export type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceSnapshot, WorkspaceView }

export type SessionSummaryLike = SessionSummary
export type SessionListSnapshotLike = Pick<SessionListState, 'ids' | 'byId'> & { current?: SessionId }

export type SessionsRuntimeLike = Omit<Pick<ISessions, 'list' | 'binding' | 'fork'>, 'list'> & {
  open?: (sessionId: SessionId) => unknown
  list: { getSnapshot: () => SessionListSnapshotLike }
}

export type WorkspaceViewLike = WorkspaceView
export type WorkspaceListSnapshotLike = Pick<WorkspaceSnapshot, 'items' | 'archivedSessionIds'> & {
  pinnedSessionIds?: readonly SessionId[]
}

export type WorkspacesRuntimeLike = Pick<IWorkspaces, 'list' | 'archiveSession' | 'delete'> & {
  startSession?: (workspaceId: WorkspaceId) => unknown
  pinSession?: (sessionId: SessionId) => Promise<void>
  unpinSession?: (sessionId: SessionId) => Promise<void>
}

export interface ActionOutcome {
  ok: boolean
  error?: string
}

/** 右键菜单扩展协议：其他 Web 插件登记到全局注册表的一条扩展项。 */
export interface ContextMenuExtension {
  id: string
  order?: number
  label?: string
  visible?: (context: { session?: SessionSummaryLike | null, row: Element | null }) => boolean
  run: (context: {
    session?: SessionSummaryLike | null
    row: Element | null
    sessions: SessionsRuntimeLike
    workspaces: WorkspacesRuntimeLike
    close: () => void
  }) => void | Promise<void>
}

/** `dsh:rightclick-menu` 事件 detail（每次打开菜单时派发）。 */
export interface ContextMenuEventDetail {
  row: Element | null
  action: HTMLElement | null
  session: SessionSummaryLike | null
  workspace: WorkspaceViewLike | null
  target: EventTarget | null
  x: number
  y: number
  extensions: ContextMenuExtension[]
}
