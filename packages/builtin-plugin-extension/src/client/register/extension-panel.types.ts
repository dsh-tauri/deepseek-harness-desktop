export interface SessionListSnapshot {
  current?: string
  ids: string[]
}

export interface WorkspaceListItem {
  workspaceId?: string
  id?: string
  sessionIds?: readonly string[]
  updatedAt?: number | string
}

export interface WorkspaceListSnapshot {
  items?: WorkspaceListItem[]
  recentWorkspaceId?: string
}
