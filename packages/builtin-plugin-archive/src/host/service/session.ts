import type { AgentLike, SessionHost, SessionLike, SessionStoreEntryLike } from '../types'
import type { LiveSessionDisposition, OpenSessionDirectoryResult } from './session.types'
import { rmSync } from 'node:fs'
import { getServerContext } from 'dsh-h3/utils'
import { defineService, openDirectory } from 'dsh-tauri'
import { dirname, resolve } from 'pathe'
import { PLUGIN_ID } from '../../shared/constants'
import { server } from '../server'
import { findSessionDataDir, isWithinRoot, readDirectory, sessionsRoot } from './session.utils'

const AGENT_IDLE_TIMEOUT_MS = 20_000

const DETACH_SETTLE_MS = 250

const REMOVE_DIR_RETRY = { maxRetries: 5, retryDelay: 50 } as const

export const session = defineService({
  get(id: string): SessionLike | null {
    if (!id)
      return null
    return liveSession(getServerContext<SessionHost>(server), id) ?? null
  },

  async dispose(ids: readonly string[]): Promise<string[]> {
    const host = getServerContext<SessionHost>(server)
    const stillLive: string[] = []
    let detached = false
    for (const id of ids) {
      const agent = host.agents?.get?.(id)
      if (agent !== undefined && !await settleAgent(host, id, agent)) {
        stillLive.push(id)
        continue
      }
      const disposition = await detachLive(host, id)
      if (disposition === 'detached')
        detached = true
      else if (disposition === 'stalled')
        stillLive.push(id)
    }
    if (detached)
      await delay(DETACH_SETTLE_MS)
    return stillLive
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
    rmSync(dir, { recursive: true, force: true, ...REMOVE_DIR_RETRY })
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

async function detachLive(host: SessionHost, id: string): Promise<LiveSessionDisposition> {
  const sessions = host.sessions
  const live = liveSession(host, id)
  if (live === undefined)
    return 'cold'
  if (typeof sessions.flush === 'function') {
    try {
      await sessions.flush(live)
    }
    catch (error) {
      warn(host, `会话 '${id}' 删除前落盘失败：${describeError(error)}`)
    }
  }
  const store = sessions.store
  const entry: SessionStoreEntryLike | undefined = store instanceof Map ? store.get(id) : undefined
  if (typeof entry?.detach !== 'function') {
    warn(host, `宿主未暴露内存会话摘除接口，会话 '${id}' 可能在删除后重新出现在会话列表`)
    return 'stalled'
  }
  try {
    entry.detach()
  }
  catch (error) {
    warn(host, `会话 '${id}' 从宿主内存摘除失败：${describeError(error)}`)
    return 'stalled'
  }
  if (liveSession(host, id) !== undefined) {
    warn(host, `会话 '${id}' 未能即时从宿主内存摘除`)
    return 'stalled'
  }
  return 'detached'
}

function liveSession(host: SessionHost, id: string): SessionLike | undefined {
  const sessions = host.sessions
  return sessions.get?.(id) ?? sessions.list?.().find(item => item.id === id)
}

async function settleAgent(host: SessionHost, id: string, agent: AgentLike): Promise<boolean> {
  if (typeof agent.cancel !== 'function')
    return false
  agent.cancel({ kind: 'disposed' })
  if (typeof agent.whenIdle !== 'function')
    return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = Symbol('idle-timeout')
  const deadline = new Promise<typeof expired>((resolveDeadline) => {
    timer = setTimeout(resolveDeadline, AGENT_IDLE_TIMEOUT_MS, expired)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([agent.whenIdle().then(() => undefined), deadline])
    if (outcome !== expired)
      return true
    warn(host, `会话 '${id}' 在 ${AGENT_IDLE_TIMEOUT_MS}ms 内未进入空闲，已中止删除`)
    return false
  }
  catch (error) {
    warn(host, `会话 '${id}' 停止活动失败，已中止删除：${describeError(error)}`)
    return false
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

function pruneEmptyParents(root: string, parent: string): void {
  if (!isWithinRoot(root, parent) || resolve(parent) === resolve(root))
    return
  const entries = readDirectory(parent)
  if (entries === null || entries.length > 0)
    return
  rmSync(parent, { recursive: true, force: true })
  pruneEmptyParents(root, dirname(parent))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function warn(host: SessionHost, message: string): void {
  host.logger?.warn?.(`[${PLUGIN_ID}] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
