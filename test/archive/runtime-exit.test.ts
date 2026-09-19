import { describe, expect, it } from 'vitest'
import { runtimeExitMessageKey, shouldAcceptRuntimeExit } from '../../src/store/modules/harness/runtime'

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
})
