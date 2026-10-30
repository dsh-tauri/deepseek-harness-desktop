import type {
  ActionOutcome,
  SessionId,
  SessionsRuntimeLike,
  SessionSummaryLike,
  WorkspaceId,
  WorkspacesRuntimeLike,
  WorkspaceViewLike,
} from '../types'
import { get } from 'dsh-tauri/client'
import { postOpenPath, postOpenUrl } from '../apis'
import { locale } from '../locales'
import { externalUrl } from '../utils/url'

/** Action：用系统默认浏览器打开外链（只放行 http/https）。 */
export async function openExternalUrl(input: { url: string }): Promise<ActionOutcome> {
  const url = externalUrl(input.url)
  if (!url)
    return { ok: false, error: locale.text('openFailed', { reason: locale.text('invalidLink') }) }
  try {
    const result = await postOpenUrl({ url })
    if (!result?.ok)
      return { ok: false, error: locale.text('openFailed', { reason: result?.error || locale.text('unknownError') }) }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：在系统文件管理器中打开目录（插件自家宿主路由，不依赖核心 Remote）。 */
export async function openInExplorer(input: { path: string }): Promise<ActionOutcome> {
  try {
    const result = await postOpenPath({ path: input.path })
    if (!result?.ok)
      return { ok: false, error: locale.text('openFailed', { reason: result?.error || locale.text('unknownError') }) }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：重命名会话（官方重命名不可用时的回退路径）。 */
export async function renameSession(input: {
  sessions: SessionsRuntimeLike
  sessionId: SessionId
  title: string
}): Promise<ActionOutcome> {
  const binding = input.sessions.binding(input.sessionId)
  if (!binding)
    return { ok: false, error: locale.text('sessionServiceUnavailable') }
  try {
    const result = await binding.session.rename(input.title)
    if (!result.ok)
      return { ok: false, error: result.error?.message || locale.text('renameFailed') }
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：归档单个会话（官方归档不可用时的回退路径）。 */
export async function archiveSession(input: {
  workspaces: WorkspacesRuntimeLike
  sessionId: SessionId
}): Promise<ActionOutcome> {
  try {
    await input.workspaces.archiveSession(input.sessionId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Query：官方是否提供置顶会话能力（0.1.7 起）；旧核心缺席时右键菜单不展示该入口。 */
export function supportsSessionPin(workspaces: WorkspacesRuntimeLike): boolean {
  return typeof workspaces.pinSession === 'function' && typeof workspaces.unpinSession === 'function'
}

/** Query：会话是否已置顶（旧核心无置顶集合时按未置顶处理）。 */
export function isSessionPinned(input: {
  workspaces: WorkspacesRuntimeLike
  sessionId: SessionId
}): boolean {
  return input.workspaces.list.getSnapshot().pinnedSessionIds?.includes(input.sessionId) ?? false
}

/** Action：置顶/取消置顶会话（官方 0.1.7 能力；能力缺席时不执行）。 */
export async function togglePinSession(input: {
  workspaces: WorkspacesRuntimeLike
  sessionId: SessionId
  pinned: boolean
}): Promise<ActionOutcome> {
  const { workspaces, sessionId, pinned } = input
  const pin = workspaces.pinSession
  const unpin = workspaces.unpinSession
  if (!pin || !unpin)
    return { ok: false, error: locale.text('pinSessionUnavailable') }
  try {
    // 以服务实例为接收者调用：官方实现依赖 this。
    await (pinned ? unpin : pin).call(workspaces, sessionId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：分叉会话（官方分叉不可用时的回退路径）。 */
export async function forkSession(input: {
  sessions: SessionsRuntimeLike
  sessionId: SessionId
}): Promise<ActionOutcome> {
  try {
    const childId = await input.sessions.fork({ sessionId: input.sessionId, increaseTitle: true })
    input.sessions.open?.(childId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/**
 * 候选口径与 `dsh-tauri-archive` 对齐：官方侧栏会展示的正式会话。
 * 子代理会话虽可能挂在 workspace 名下，但侧栏不渲染（见 issue #1151）。
 */
function isFormalSession(session: SessionSummaryLike | undefined): boolean {
  return session !== undefined && session.blank !== true && session.origin !== 'subagent'
}

/** Query：未分组中的正式会话 id（排除已归档、已归属工作区、空白与子代理会话）。 */
export async function loadUngroupedSessions(input: {
  workspaces: WorkspacesRuntimeLike
  sessions: SessionsRuntimeLike
}): Promise<SessionId[]> {
  const snapshot = input.workspaces.list.getSnapshot()
  const assigned = snapshot.items.flatMap(workspace => workspace.sessionIds)
  const sessionSnapshot = input.sessions.list.getSnapshot()
  const excluded = new Set([...assigned, ...snapshot.archivedSessionIds])
  return sessionSnapshot.ids.filter(id => !excluded.has(id) && isFormalSession(sessionSnapshot.byId[id]))
}

/** Query：工作区中尚未归档的正式会话 id。 */
export async function loadWorkspaceSessions(input: {
  workspaces: WorkspacesRuntimeLike
  sessions: SessionsRuntimeLike
  workspace: WorkspaceViewLike
}): Promise<SessionId[]> {
  const archived = new Set(input.workspaces.list.getSnapshot().archivedSessionIds)
  const byId = input.sessions.list.getSnapshot().byId
  return input.workspace.sessionIds.filter(id => !archived.has(id) && isFormalSession(byId[id]))
}

/** Action：逐个归档会话。 */
export async function archiveSessions(input: {
  workspaces: WorkspacesRuntimeLike
  sessionIds: SessionId[]
}): Promise<ActionOutcome> {
  try {
    for (const sessionId of input.sessionIds)
      await input.workspaces.archiveSession(sessionId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

/** Action：删除工作区（官方非破坏性删除：仅移除注册，文件夹与会话记录保留）。 */
export async function deleteWorkspace(input: {
  workspaces: WorkspacesRuntimeLike
  workspaceId: WorkspaceId
}): Promise<ActionOutcome> {
  try {
    await input.workspaces.delete(input.workspaceId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

export async function startWorkspaceSession(input: {
  workspaces: WorkspacesRuntimeLike
  workspaceId: WorkspaceId
}): Promise<ActionOutcome> {
  const start = input.workspaces.startSession
  if (typeof start !== 'function')
    return { ok: false, error: locale.text('newSessionUnavailable') }
  try {
    await start.call(input.workspaces, input.workspaceId)
    return { ok: true }
  }
  catch (error) {
    return fail(error)
  }
}

// --- internal ---

function fail(error: unknown): ActionOutcome {
  return { ok: false, error: get(error, 'message') || String(error) }
}
