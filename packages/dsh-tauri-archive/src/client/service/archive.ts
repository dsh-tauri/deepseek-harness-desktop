import type { GetApiTauriArchiveSessionArchiveResponse as ArchivedListPayload } from '../apis/index.type'
import type { ActionOutcome, Resync } from './archive.types'
import { uniq } from 'dsh-tauri/client'
import {
  deleteSessionArchive,
  deleteSessionWorkspaceArchive,
  getSessionArchive,
  postSessionArchive,
  postSessionArchiveClear,
  postSessionArchiveRestore,
  postSessionOpenPath,
  postSessionWorkspaceArchive,
} from '../apis'
import { ARCHIVE_RESYNC_TIMEOUT_MS } from '../constants'
import { locale } from '../locales'
import { store } from '../store'
import { errorMessage, withTimeout } from './archive.utils'

/**
 * 拉取归档载荷并写入 store（Query）。
 * 刷新成功即载荷权威，清空抑制标记 —— 否则取消归档后再归档的会话会被旧标记永久过滤。
 */
export async function fetchArchive(): Promise<ArchivedListPayload | null> {
  const generation = store.archive.beginRefresh()
  store.archive.loading = true
  store.archive.error = ''
  try {
    const payload = await getSessionArchive()
    if (!store.archive.isCurrentRefresh(generation))
      return null
    store.archive.archived = payload
    store.archive.loading = false
    store.archive.suppressedSessionIds = []
    return payload
  }
  catch (error) {
    if (!store.archive.isCurrentRefresh(generation))
      return null
    store.archive.loading = false
    store.archive.error = errorMessage(error)
    return null
  }
}

export function archiveSession(input: { sessionId: string }): Promise<ActionOutcome> {
  store.archive.suppressedSessionIds = store.archive.suppressedSessionIds.filter(id => id !== input.sessionId)
  return runMutation({ mutate: () => postSessionArchive({ sessionId: input.sessionId }) })
}

export function archiveWorkspace(input: { workspaceId: string, sessionIds: readonly string[] }): Promise<ActionOutcome> {
  return runMutation({ mutate: () => postSessionWorkspaceArchive({ workspaceId: input.workspaceId, sessionIds: [...input.sessionIds] }) })
}

export function unarchiveSession(input: { sessionId: string, resync?: Resync }): Promise<ActionOutcome> {
  return runMutation({ mutate: () => postSessionArchiveRestore({ sessionId: input.sessionId }), resync: input.resync, sessionIds: [input.sessionId] })
}

export function deleteSession(input: { sessionId: string, resync?: Resync }): Promise<ActionOutcome> {
  return runMutation({ mutate: () => deleteSessionArchive({ sessionId: input.sessionId }), resync: input.resync, sessionIds: [input.sessionId] })
}

export function deleteWorkspaceSessions(input: { sessionIds: readonly string[], resync?: Resync }): Promise<ActionOutcome> {
  return runMutation({ mutate: () => deleteSessionWorkspaceArchive({ sessionIds: [...input.sessionIds] }), resync: input.resync, sessionIds: input.sessionIds })
}

export function clearArchive(input: { resync?: Resync } = {}): Promise<ActionOutcome> {
  const sessionIds = [...store.archive.archived.archivedSessionIds]
  return runMutation({ mutate: () => postSessionArchiveClear(), resync: input.resync, sessionIds })
}

export async function openSessionDir(input: { sessionId: string }): Promise<ActionOutcome> {
  try {
    const result = await postSessionOpenPath({ sessionId: input.sessionId })
    if (!result.ok)
      throw new Error(locale.text('openFailed', { reason: result.error ?? '' }))
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

// --- internal ---

interface MutationInput {
  mutate: () => Promise<unknown>
  resync?: Resync
  sessionIds?: readonly string[]
}

/** 包裹一次破坏性/恢复变更：置 pending，成功后重拉归档载荷与宿主镜像，失败写入 error。 */
async function runMutation(input: MutationInput): Promise<ActionOutcome> {
  store.archive.pending = true
  store.archive.error = ''
  try {
    await input.mutate()
    const sessionIds = input.sessionIds ?? []
    if (sessionIds.length > 0)
      store.archive.suppressedSessionIds = uniq([...store.archive.suppressedSessionIds, ...sessionIds])
    await Promise.all([
      fetchArchive(),
      input.resync ? withTimeout(input.resync(), ARCHIVE_RESYNC_TIMEOUT_MS) : Promise.resolve(),
    ])
    return { ok: true }
  }
  catch (error) {
    store.archive.error = errorMessage(error)
    return { ok: false, error: store.archive.error }
  }
  finally {
    store.archive.pending = false
  }
}
