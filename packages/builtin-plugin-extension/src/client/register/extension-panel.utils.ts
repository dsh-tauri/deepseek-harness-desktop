import type { SessionListSnapshot, WorkspaceListItem, WorkspaceListSnapshot } from './extension-panel.types'

function workspaceId(item: WorkspaceListItem): string | undefined {
  return item.workspaceId ?? item.id
}

export function sessionSnapshotOf(value: unknown): SessionListSnapshot {
  if (typeof value !== 'object' || value === null)
    return { ids: [] }
  const snapshot = value as Record<string, unknown>
  return {
    ...(typeof snapshot.current === 'string' ? { current: snapshot.current } : {}),
    ids: Array.isArray(snapshot.ids) ? snapshot.ids.filter((id): id is string => typeof id === 'string') : [],
  }
}

export function workspaceSnapshotOf(value: unknown): WorkspaceListSnapshot {
  if (typeof value !== 'object' || value === null)
    return {}
  const snapshot = value as Record<string, unknown>
  const items = Array.isArray(snapshot.items)
    ? snapshot.items.filter((item: unknown): item is WorkspaceListItem => typeof item === 'object' && item !== null)
    : undefined
  return {
    ...(items !== undefined ? { items } : {}),
    ...(typeof snapshot.recentWorkspaceId === 'string' ? { recentWorkspaceId: snapshot.recentWorkspaceId } : {}),
  }
}

export function chooseWorkspace(
  sessions: SessionListSnapshot,
  workspaces: WorkspaceListSnapshot,
): string | undefined {
  const items = workspaces.items ?? []
  const current = sessions.current
  const currentItem = current === undefined
    ? undefined
    : items.find(item => item.sessionIds?.includes(current))
  const currentId = currentItem === undefined ? undefined : workspaceId(currentItem)
  if (currentId !== undefined)
    return currentId
  if (workspaces.recentWorkspaceId !== undefined && items.some(item => workspaceId(item) === workspaces.recentWorkspaceId))
    return workspaces.recentWorkspaceId
  return items.map(workspaceId).find((id): id is string => id !== undefined)
}
