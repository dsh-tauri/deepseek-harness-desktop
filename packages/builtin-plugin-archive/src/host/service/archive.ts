import type { SessionHost } from '../types'
import type { ArchivedListPayload } from './ledger.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { PLUGIN_ID } from '../../shared/constants'
import { archiveHooks } from '../events'
import { server } from '../server'
import { ledger } from './ledger'
import { session } from './session'

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
    await ledger.remove([sessionId])
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

  const stillLive = await session.dispose(ids)
  if (stillLive.length > 0) {
    host.logger?.warn?.(`[${PLUGIN_ID}] ${stillLive.length} 个会话未能从宿主内存摘除，已中止本次删除`)
    throw new Error(`会话 '${stillLive[0]}' 仍在运行或无法从宿主内存摘除，已中止删除`)
  }

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

  await ledger.forget(ids)
  notifyRemoved(host, ids)
  void archiveHooks.callHook('archive:deleted', ids)
  host.logger?.info?.(`[${PLUGIN_ID}] permanently deleted ${ids.length} archived session(s) (data removed: ${removed})`)
  return { ok: true as const }
}

function notifyRemoved(host: SessionHost, ids: readonly string[]): void {
  if (typeof host.emit !== 'function') {
    host.logger?.warn?.(`[${PLUGIN_ID}] 宿主未暴露事件总线，客户端不会同步移除已删除会话`)
    return
  }
  for (const sessionId of ids)
    host.emit('api-session/removed', sessionId)
}
