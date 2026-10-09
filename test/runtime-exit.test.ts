import { describe, expect, it } from 'vitest'
import { isNativeCrashCode, runtimeExitMessageKey, shouldAcceptRuntimeExit } from '../src/store/modules/harness/runtime'

describe('runtime exit acceptance', () => {
  const current = {
    serviceHealthy: true,
    serviceRunning: true,
    readinessCommitPending: false,
    busyAction: null,
    observedToken: 4,
    currentToken: 4,
    notOwned: true,
  } as const

  it('accepts an exit only after the current runtime loses ownership', () => {
    expect(shouldAcceptRuntimeExit(current)).toBe(true)
    expect(shouldAcceptRuntimeExit({ ...current, notOwned: false })).toBe(false)
    expect(shouldAcceptRuntimeExit({ ...current, serviceHealthy: false })).toBe(false)
    expect(shouldAcceptRuntimeExit({ ...current, serviceRunning: false })).toBe(false)
  })

  it('accepts an exit while the final readiness commit is pending', () => {
    expect(shouldAcceptRuntimeExit({
      ...current,
      serviceHealthy: false,
      readinessCommitPending: true,
    })).toBe(true)
  })

  it('rejects delayed events and explicit service transitions', () => {
    expect(shouldAcceptRuntimeExit({ ...current, currentToken: 5 })).toBe(false)
    expect(shouldAcceptRuntimeExit({ ...current, busyAction: 'shutdown' })).toBe(false)
  })

  it('accepts a new process exit after readiness even before start or restart clears busy state', () => {
    expect(shouldAcceptRuntimeExit({ ...current, busyAction: 'start' })).toBe(true)
    expect(shouldAcceptRuntimeExit({ ...current, busyAction: 'restart' })).toBe(true)
  })

  it('does not suppress a real exit during an unrelated browser action', () => {
    expect(shouldAcceptRuntimeExit({ ...current, busyAction: 'openBrowser' })).toBe(true)
  })

  it('preserves exit code zero as a known code', () => {
    expect(runtimeExitMessageKey(0)).toBe('errors.process_exited_with_code')
    expect(runtimeExitMessageKey(null)).toBe('errors.process_exited_without_code')
    expect(runtimeExitMessageKey(undefined)).toBe('errors.process_exited_without_code')
  })

  it('uses the native crash wording only for Windows NTSTATUS exit codes', () => {
    // 0xC0000005 访问违例：实测用户机器上 Harness 跑满 12 小时后被原生层打死，
    // 日志里没有任何 JS 异常，旧文案只报裸数字，容易被当成堆耗尽。
    expect(isNativeCrashCode(0xC0000005)).toBe(true)
    expect(runtimeExitMessageKey(0xC0000005)).toBe('errors.process_exited_native_crash')
    expect(runtimeExitMessageKey(3221225477)).toBe('errors.process_exited_native_crash')
    expect(isNativeCrashCode(0xC0000409)).toBe(true)
    expect(isNativeCrashCode(0xC0000374)).toBe(true)
    expect(isNativeCrashCode(0xC000001D)).toBe(true)
    expect(isNativeCrashCode(0xC00000FD)).toBe(true)
    expect(isNativeCrashCode(134)).toBe(false)
    expect(isNativeCrashCode(1)).toBe(false)
    expect(isNativeCrashCode(null)).toBe(false)
  })
})
