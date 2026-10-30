import type { SessionHost, SessionLike } from '../types'
import type { OpenSessionDirectoryResult } from './session.types'
import { rmSync } from 'node:fs'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, openDirectory } from 'dsh-tauri'
import { dirname, resolve } from 'pathe'
import { server } from '../server'
import { findSessionDataDir, isWithinRoot, readDirectory, sessionsRoot } from './session.utils'

export const session = defineService({
  get(id: string): SessionLike | null {
    if (!id)
      return null
    const sessions = getServerContext<SessionHost>(server).sessions
    return sessions.get?.(id)
      ?? sessions.list?.().find(item => item.id === id)
      ?? null
  },

  remove(ids: readonly string[]): string[] {
    const sessions = getServerContext<SessionHost>(server).sessions
    const live = ids.filter(id => sessions.get?.(id) && id)
    if (live.length > 0 && !sessions.remove)
      throw new Error('宿主未提供 SessionStore.remove，请先更新桌面壳')
    return live.filter(id => !sessions.remove?.(id))
  },

  getDir(id: string): string | null {
    if (!id)
      return null
    return findSessionDataDir(sessionsRoot(), id)
  },

  removeDir(id: string): boolean {
    const root = sessionsRoot()
    const dir = id ? findSessionDataDir(root, id) : null
    if (dir === null)
      return false
    rmSync(dir, { recursive: true, force: true })
    pruneEmptyParents(root, dirname(dir))
    return true
  },

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

function pruneEmptyParents(root: string, parent: string): void {
  if (!isWithinRoot(root, parent) || resolve(parent) === resolve(root))
    return
  const entries = readDirectory(parent)
  if (entries === null || entries.length > 0)
    return
  rmSync(parent, { recursive: true, force: true })
  pruneEmptyParents(root, dirname(parent))
}
