import type { SidebarBusyAction } from '@/store/modules/harness'

export interface RuntimeExitAcceptance {
  serviceHealthy: boolean
  serviceRunning: boolean
  readinessCommitPending: boolean
  busyAction: SidebarBusyAction
  observedToken: number
  currentToken: number
  notOwned: boolean
}

/** 只有当前运行实例确已失去后端进程时，才采纳异步退出事件。 */
export function shouldAcceptRuntimeExit({
  serviceHealthy,
  serviceRunning,
  readinessCommitPending,
  busyAction,
  observedToken,
  currentToken,
  notOwned,
}: RuntimeExitAcceptance): boolean {
  if (!serviceHealthy && !readinessCommitPending)
    return false
  if (!serviceRunning)
    return false
  if (busyAction === 'shutdown')
    return false
  if (observedToken !== currentToken)
    return false
  return notOwned
}

/** 退出码 0 仍是已知退出码；只有 null/undefined 才使用“未知退出码”文案。 */
export function runtimeExitMessageKey(exitCode: number | null | undefined): string {
  if (exitCode == null)
    return 'errors.process_exited_without_code'
  if (isNativeCrashCode(exitCode))
    return 'errors.process_exited_native_crash'
  return 'errors.process_exited_with_code'
}

/** Windows NTSTATUS 形态的原生退出码：0xC0000005 访问违例 / 0xC0000409 栈缓冲溢出等。 */
const NATIVE_CRASH_CODES = new Set([
  0xC0000005,
  0xC0000409,
  0xC0000374,
  0xC000001D,
  0xC00000FD,
])

/** 退出码是否为 Windows 原生崩溃（不是 JS 层异常，也不是 V8 堆耗尽）。 */
export function isNativeCrashCode(exitCode: number | null | undefined): boolean {
  return exitCode != null && NATIVE_CRASH_CODES.has(exitCode >>> 0)
}
