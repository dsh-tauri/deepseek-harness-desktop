import type { ClientAdapter } from 'dsh-tauri/client'

/** `workspaces.list` 投影的读取面（官方投影形状随版本漂移，只取用到的字段）。 */
interface WorkspaceItem {
  id?: string
  sessionIds?: readonly string[]
  workspaceId?: string
}

interface SessionsSnapshot {
  current?: string
  ids?: readonly string[]
}

interface WorkspacesSnapshot {
  items?: WorkspaceItem[]
  recentWorkspaceId?: string
}

/**
 * 跟随官方新建会话的目标顺序：当前会话所在工作区 → 最近工作区 → 第一个工作区。
 *
 * 列表投影经适配层取（`adapter.sessions.list` / `adapter.workspaces.list`），快照结构
 * 按需收窄——服务或字段缺席时按空处理，不猜核心版本。
 */
export function chooseWorkspace(adapter: ClientAdapter): string | undefined {
  const sessions = (adapter.sessions.list?.getSnapshot() ?? {}) as SessionsSnapshot
  const workspaces = (adapter.workspaces.list?.getSnapshot() ?? {}) as WorkspacesSnapshot
  const items = workspaces.items ?? []
  const current = sessions.current
  const currentItem = current === undefined
    ? undefined
    : items.find(item => item.sessionIds?.includes(current))
  const currentId = currentItem === undefined ? undefined : workspaceIdOf(currentItem)
  if (currentId !== undefined)
    return currentId
  if (
    workspaces.recentWorkspaceId !== undefined
    && items.some(item => workspaceIdOf(item) === workspaces.recentWorkspaceId)
  ) {
    return workspaces.recentWorkspaceId
  }
  return items.map(workspaceIdOf).find((id): id is string => id !== undefined)
}

/** 领域动作失败原因（服务层统一把未知异常投影为可展示文本）。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- internal ---

function workspaceIdOf(item: WorkspaceItem): string | undefined {
  return item.workspaceId ?? item.id
}
