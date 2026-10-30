import type { ClientAdapter, ClientContext, SessionId } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { getUngrouped } from '../apis'

interface ListSnapshotLike {
  current?: SessionId
  byId?: Record<string, { blank?: boolean, cwd?: string } | undefined>
}

export function startUngroupedSession(ctx: ClientContext, adapter: ClientAdapter): void {
  void connectUngroupedSession(ctx, adapter).then(
    (sessionId) => {
      adapter.openSession(sessionId)
      ctx.layout.selectPanel(null)
    },
    (reason: unknown) => {
      console.warn(`[${PLUGIN_ID}] 未分组新建会话失败:`, reason)
    },
  )
}

async function connectUngroupedSession(ctx: ClientContext, adapter: ClientAdapter): Promise<SessionId> {
  const cwd = await resolveUngroupedCwd()
  const current = snapshotOf(ctx, adapter).current
  if (current !== undefined && isUngroupedBlank(ctx, adapter, current, cwd))
    return current
  return cwd === undefined ? ctx.sessions.create() : ctx.sessions.create({ cwd })
}

function isUngroupedBlank(
  ctx: ClientContext,
  adapter: ClientAdapter,
  sessionId: SessionId,
  cwd: string | undefined,
): boolean {
  const summary = snapshotOf(ctx, adapter).byId?.[sessionId]
  if (summary === undefined || !summary.blank)
    return false
  if (cwd !== undefined && summary.cwd !== cwd)
    return false
  const workspaces = readWorkspaces(ctx)
  return workspaces === undefined || workspaces.every(workspace => !workspace.sessionIds.includes(sessionId))
}

async function resolveUngroupedCwd(): Promise<string | undefined> {
  try {
    const response = await getUngrouped()
    const cwd = response?.cwd
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
  }
  catch (reason) {
    console.warn(`[${PLUGIN_ID}] 未分组目录解析失败，沿用核心默认目录:`, reason)
    return undefined
  }
}

function snapshotOf(ctx: ClientContext, adapter: ClientAdapter): ListSnapshotLike {
  const list = adapter.sessions.list ?? ctx.sessions.list
  return (list.getSnapshot() ?? {}) as ListSnapshotLike
}

interface WorkspacesRuntime {
  list: { getSnapshot: () => { items: readonly { sessionIds: readonly SessionId[] }[] } }
}

function readWorkspaces(ctx: ClientContext): readonly { sessionIds: readonly SessionId[] }[] | undefined {
  try {
    const workspaces = ctx.get('workspaces') as WorkspacesRuntime | undefined
    return workspaces?.list.getSnapshot().items
  }
  catch {
    return undefined
  }
}
