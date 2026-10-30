import type { SessionHost } from '../types'
import type { ArchivedListPayload } from './ledger.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { archiveHooks } from '../events'
import { server } from '../server'
import { ledger } from './ledger'
import { session } from './session'

const LOG_PREFIX = 'dsh-tauri-archive'

export const archive = defineService({
  async archive(sessionId: string): Promise<ArchivedListPayload> {
    await ledger.save(sessionId)
    void archiveHooks.callHook('archive:added', sessionId)
    return ledger.load()
  },

  async archiveWorkspace(sessionIds: readonly string[]): Promise<ArchivedListPayload> {
    for (const sessionId of sessionIds) {
      await ledger.save(sessionId)
      void archiveHooks.callHook('archive:added', sessionId)
    }
    return ledger.load()
  },

  async unarchive(sessionId: string): Promise<{ ok: true }> {
    await ledger.remove([sessionId], 'attach')
    void archiveHooks.callHook('archive:restored', sessionId)
    return { ok: true as const }
  },

  async delete(sessionId: string): Promise<{ ok: true }> {
    return permanentlyDelete([sessionId])
  },

  async deleteSelected(sessionIds: readonly string[]): Promise<{ ok: true }> {
    return permanentlyDelete(sessionIds)
  },

  async deleteAll(): Promise<{ ok: true }> {
    return permanentlyDelete(ledger.list())
  },
})

async function permanentlyDelete(rawIds: readonly string[]): Promise<{ ok: true }> {
  const host = getServerContext<SessionHost>(server)
  const ids = [...new Set(rawIds.map(String).filter(Boolean))]
  if (ids.length === 0)
    throw new Error('缺少 sessionIds')

  const archived = new Set(ledger.list())
  const missing = ids.filter(id => !archived.has(id))
  if (missing.length > 0)
    throw new Error(`会话 '${missing[0]}' 不在归档集合中，拒绝删除`)

  const liveFailures = session.remove(ids)
  for (const sessionId of liveFailures)
    host.logger?.warn?.(`[${LOG_PREFIX}] 会话 '${sessionId}' 无法从内存移除，刷新后消失`)

  let removed = 0
  for (const sessionId of ids) {
    try {
      if (session.removeDir(sessionId))
        removed += 1
    }
    catch (error) {
      throw new Error(`删除会话数据失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  await ledger.remove(ids)
  void archiveHooks.callHook('archive:deleted', ids)
  host.logger?.info?.(`[${LOG_PREFIX}] permanently deleted ${ids.length} archived session(s) (data removed: ${removed})`)
  return { ok: true as const }
}
