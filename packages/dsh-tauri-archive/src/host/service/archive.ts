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
  /** 归档一个会话并返回新的归档投影（幂等：已归档即无操作）。 */
  async archive(sessionId: string): Promise<ArchivedListPayload> {
    await ledger.save(sessionId)
    void archiveHooks.callHook('archive:added', sessionId)
    return ledger.load()
  },

  /** 归档一组会话（「归档工作区」），逐个写入宿主归档集合。 */
  async archiveWorkspace(sessionIds: readonly string[]): Promise<ArchivedListPayload> {
    for (const sessionId of sessionIds) {
      await ledger.save(sessionId)
      void archiveHooks.callHook('archive:added', sessionId)
    }
    return ledger.load()
  },

  /** 取消归档：归档集合移除 + 修复历史缺失的工作区归属槽位（同一事务）。 */
  async unarchive(sessionId: string): Promise<{ ok: true }> {
    await ledger.remove([sessionId], 'attach')
    void archiveHooks.callHook('archive:restored', sessionId)
    return { ok: true as const }
  },

  /** 彻底删除一个归档会话（归档集合移除 + 物理删除会话数据，不可恢复）。 */
  async delete(sessionId: string): Promise<{ ok: true }> {
    return permanentlyDelete([sessionId])
  },

  /** 彻底删除指定归档会话（批量共用一次预检与一次注册表事务）。 */
  async deleteSelected(sessionIds: readonly string[]): Promise<{ ok: true }> {
    return permanentlyDelete(sessionIds)
  },

  /** 彻底删除全部已归档会话。 */
  async deleteAll(): Promise<{ ok: true }> {
    return permanentlyDelete(ledger.list())
  },
})

// --- internal ---

/**
 * 删除事务顺序：预检（成员 + 宿主面，变更前全部完成）→ 内存移除（面校验在此完成）
 * → 物理删除（失败即中止，注册表未动可整体重试）→ 注册表事务（记账 + 归档集合
 * 在同一个 enqueueOperation 内原子完成）。任意物理失败都不会留下「数据已删但归档
 * 仍列」的幽灵。
 */
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
