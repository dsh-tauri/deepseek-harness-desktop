import type { SessionHost, SessionLike } from '../types'
import type { OpenSessionDirectoryResult } from './session.types'
import { rmSync } from 'node:fs'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, openDirectory } from 'dsh-tauri'
import { dirname, resolve } from 'pathe'
import { server } from '../server'
import { findSessionDataDir, isWithinRoot, readDirectory, sessionsRoot } from './session.utils'

export const session = defineService({
  /** 读宿主内存会话对象（get 缺失时回退到会话枚举）。 */
  get(id: string): SessionLike | null {
    if (!id)
      return null
    const sessions = getServerContext<SessionHost>(server).sessions
    return sessions.get?.(id)
      ?? sessions.list?.().find(item => item.id === id)
      ?? null
  },

  /**
   * 从宿主内存会话 store 移除（best-effort），返回无法移除的 id。
   * 删除所需面在触碰任何数据之前校验，缺失即抛错，保证失败可整体重试。
   */
  remove(ids: readonly string[]): string[] {
    const sessions = getServerContext<SessionHost>(server).sessions
    const live = ids.filter(id => sessions.get?.(id) && id)
    if (live.length > 0 && !sessions.remove)
      throw new Error('宿主未提供 SessionStore.remove，请先更新桌面壳')
    return live.filter(id => !sessions.remove?.(id))
  },

  /** 只读定位会话持久化数据目录；未找到返回 null。 */
  getDir(id: string): string | null {
    if (!id)
      return null
    return findSessionDataDir(sessionsRoot(), id)
  },

  /** 物理删除会话数据目录（找不到即 false），并清理删除后变空的父目录。 */
  removeDir(id: string): boolean {
    const root = sessionsRoot()
    const dir = id ? findSessionDataDir(root, id) : null
    if (dir === null)
      return false
    rmSync(dir, { recursive: true, force: true })
    pruneEmptyParents(root, dirname(dir))
    return true
  },

  /** 在系统文件管理器中打开会话数据目录（路径由 id 有界解析，不接受客户端路径）。 */
  async openDir(id: string): Promise<OpenSessionDirectoryResult> {
    const dir = id ? findSessionDataDir(sessionsRoot(), id) : null
    if (dir === null)
      return { ok: false, error: 'session-directory-not-found' }
    try {
      await openDirectory(dir)
    }
    catch {
      return { ok: false, error: 'not-a-directory' }
    }
    return { ok: true }
  },
})

// --- internal ---

function pruneEmptyParents(root: string, parent: string): void {
  if (!isWithinRoot(root, parent) || resolve(parent) === resolve(root))
    return
  const entries = readDirectory(parent)
  if (entries === null || entries.length > 0)
    return
  rmSync(parent, { recursive: true, force: true })
  pruneEmptyParents(root, dirname(parent))
}
