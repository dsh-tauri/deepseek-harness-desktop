import type { HostContext, WorkspaceProbe } from '../types'
/**
 * host/service/workspace.ts — 会话工作区资格（只读推演）。
 *
 * 三条判定集中在此，路由与捕获路径共用：
 *   1. 会话 cwd 必须位于 Git worktree 内（否则 `RUNNING_CHANGES_GIT_REQUIRED`）；
 *   2. PATH 上没有 git 时报 `RUNNING_CHANGES_GIT_UNAVAILABLE`——两者给用户的指引完全不同；
 *   3. 家目录本身、家目录祖先、任何盘根与 UNC 共享根一律拒绝（`UNSAFE_WORKSPACE`）。
 *
 * 性能：一次 `rev-parse` 批量取全部元数据，结果进 60s 缓存并走 stale-while-revalidate——
 * 探测挂在 pre-step 的执行屏障上，不能每次 turn 都同步阻塞在 git 上。绝不使用
 * `process.cwd()` 兜底：宿主进程的工作目录未必是会话工作区。
 */

import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { resolve } from 'pathe'
import { RUNNING_CHANGES_REASON_GIT_UNAVAILABLE as REASON_GIT_UNAVAILABLE } from '../../shared/constants'
import { REASON_GIT_REQUIRED, REASON_UNSAFE_WORKSPACE } from '../config/constants'
import { probeCache, probeRefreshing } from '../config/runtime'
import { server } from '../server'
import { gitInRepo } from '../utils/git'
import { canonicalWorkspacePath, isSystemSensitivePath, workspaceKey } from '../utils/workspace'

const GIT_PROBE_TIMEOUT_MS = 30 * 1000

const WORKSPACE_CACHE_TTL_MS = 60 * 1000

const WORKSPACE_CACHE_MAX = 64

export const workspace = defineService({
  /** 会话是否在宿主 SessionStore 中（路由据此区分 404 与「无法解析工作区」）。 */
  peek(sessionId: string): boolean {
    return sessionOf(sessionId) !== undefined
  },

  /** 探测该会话当前的工作区资格（带缓存）。 */
  async resolve(sessionId: string): Promise<WorkspaceProbe> {
    return probe(cwdOf(sessionId))
  },
})

// --- internal ---

/** 一次 rev-parse 批量取全部元数据：输出行序与参数顺序一致，省掉重复子进程。 */
const REV_PARSE_ARGS = ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir']

/** 宿主 SessionStore 中查找会话；找不到返回 undefined（调用方按未知处理）。 */
function sessionOf(sessionId: string): any {
  if (!sessionId)
    return undefined
  try {
    const ctx = getServerContext<HostContext>(server)
    return ctx.sessions?.get?.(sessionId)
      ?? ctx.sessions?.list?.().find((session: any) => session?.id === sessionId)
  }
  catch {
    return undefined
  }
}

/** 会话 cwd（header.cwd 优先，兼容 session.cwd）；缺失返回 null，不猜测进程工作目录。 */
function cwdOf(sessionId: string): string | null {
  const session = sessionOf(sessionId)
  const cwd = typeof session?.header?.cwd === 'string'
    ? session.header.cwd
    : typeof session?.cwd === 'string'
      ? session.cwd
      : ''
  return cwd.length > 0 ? cwd : null
}

function remember(key: string, result: WorkspaceProbe): void {
  // git 缺失不缓存：装好 git / 修好 PATH 后应当立即恢复，而不是等 TTL 过期。
  if (!result.ok && result.reason === REASON_GIT_UNAVAILABLE)
    return
  probeCache.set(key, { at: Date.now(), result })
  if (probeCache.size <= WORKSPACE_CACHE_MAX)
    return
  const oldest = [...probeCache.entries()].sort((left, right) => left[1].at - right[1].at)[0]
  if (oldest !== undefined)
    probeCache.delete(oldest[0])
}

/** 后台刷新（stale-while-revalidate 的异步半边）：结果直接落缓存。 */
function refreshInBackground(key: string, cwd: string): void {
  if (probeRefreshing.has(key))
    return
  probeRefreshing.add(key)
  void probeUncached(cwd)
    .then(result => remember(key, result))
    .catch(() => undefined)
    .finally(() => {
      probeRefreshing.delete(key)
    })
}

async function probeUncached(cwd: string): Promise<WorkspaceProbe> {
  const probed = await gitInRepo(cwd, REV_PARSE_ARGS, { timeoutMs: GIT_PROBE_TIMEOUT_MS })
  if (!probed.ok)
    return { ok: false, reason: probed.code === 'ENOENT' ? REASON_GIT_UNAVAILABLE : REASON_GIT_REQUIRED }
  const lines = probed.out.split(/\r?\n/u).map(line => line.trim())
  if (lines[0] !== 'true')
    return { ok: false, reason: REASON_GIT_REQUIRED }
  const root = canonicalWorkspacePath(resolve(cwd, lines[1] ?? ''))
  const commonDir = canonicalWorkspacePath(resolve(cwd, lines[2] ?? ''))
  if (root.length === 0)
    return { ok: false, reason: REASON_GIT_REQUIRED }
  if (isSystemSensitivePath(root))
    return { ok: false, reason: REASON_UNSAFE_WORKSPACE }
  return { ok: true, root, commonDir }
}

async function probe(cwd: string | null): Promise<WorkspaceProbe> {
  if (cwd === null)
    return { ok: false, reason: REASON_GIT_REQUIRED }
  if (isSystemSensitivePath(cwd))
    return { ok: false, reason: REASON_UNSAFE_WORKSPACE }
  const key = workspaceKey(cwd)
  const cached = probeCache.get(key)
  if (cached !== undefined) {
    if (Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS)
      return cached.result
    // 元数据短暂陈旧可接受（探测在执行屏障上）：先回缓存值，后台刷新下一次生效。
    refreshInBackground(key, cwd)
    return cached.result
  }
  const result = await probeUncached(cwd)
  remember(key, result)
  return result
}
