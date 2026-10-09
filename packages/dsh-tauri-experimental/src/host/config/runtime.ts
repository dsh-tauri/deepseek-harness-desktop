/**
 * host/config/runtime.ts — 宿主侧内存单例（SSOT）。
 *
 * 进程内全部跨调用可变状态收拢在这里：工作区串行队列、资格探测缓存、账本串行队列、
 * 在途 turn 捕获状态与容量治理标记。服务层只读这些实例，不再各自持有模块级散装状态。
 */

import type { ActiveTurn, BeginningTurn } from '../service/capture.types'
import type { WorkspaceProbe } from '../types'
import { DSH_HOME } from 'dsh-tauri'
import { createWorkspaceLock } from '../utils/lock'
import { createWorkspaceQueue } from '../utils/queue'

/**
 * 工作区级串行队列：私有仓 index/refs 是共享可变状态，捕获、结算、实时读数与容量治理
 * 全部串行。队列内再叠一层**跨进程内核锁**：同一个 `DSH_HOME` 下的第二个宿主进程
 * 也走同一把锁，两个进程才真正不会同动一份私有仓（见 utils/lock.ts）。
 */
export const workspaceQueue = createWorkspaceQueue({ lock: createWorkspaceLock({ dshHome: DSH_HOME }) })

/** 工作区资格探测缓存（60s TTL，stale-while-revalidate）。 */
export const probeCache = new Map<string, { at: number, result: WorkspaceProbe }>()
export const probeRefreshing = new Set<string>()

/** 会话账本的 load-modify-save 串行队列（队尾结算即出队）。 */
export const ledgerQueues = new Map<string, Promise<unknown>>()

/** 进行中的 turn 捕获状态（key = `${sessionId}:${turn}`）。 */
export const activeTurns = new Map<string, ActiveTurn>()
export const beginningTurns = new Map<string, BeginningTurn>()
export const settlingTurns = new Set<string>()

/** 已做过容量治理的工作区（每进程每个工作区只治理一次）。 */
export const retainedWorkspaces = new Set<string>()

/** 插件是否已卸载：卸载后不再登记新的捕获条目与轮询。 */
let captureDisposed = false

export function isCaptureDisposed(): boolean {
  return captureDisposed
}

export function setCaptureDisposed(disposed: boolean): void {
  captureDisposed = disposed
}

/** 插件重新装配：清空上一轮遗留的内存态并恢复运行。 */
export function resetHostRuntime(): void {
  clearState()
  captureDisposed = false
}

/** 插件卸载：清空内存态。 */
export function disposeRuntime(): void {
  clearState()
  captureDisposed = true
}

function clearState(): void {
  probeCache.clear()
  probeRefreshing.clear()
  ledgerQueues.clear()
  activeTurns.clear()
  beginningTurns.clear()
  settlingTurns.clear()
  retainedWorkspaces.clear()
}
