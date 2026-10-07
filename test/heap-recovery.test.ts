import { describe, expect, it, vi } from 'vitest'
import { planHeapRecovery } from '../src/store/modules/harness/heap-recovery'

function input(overrides: Partial<Parameters<typeof planHeapRecovery>[0]> = {}) {
  const queryLimitMb = vi.fn(async () => 16384)
  return {
    queryLimitMb,
    value: {
      heapExhausted: true,
      pluginRecoveryRequired: false,
      busy: null,
      queryLimitMb,
      ...overrides,
    },
  }
}

describe('planHeapRecovery', () => {
  it('raises the limit when the owned process died from V8 heap exhaustion', async () => {
    const { value, queryLimitMb } = input()
    await expect(planHeapRecovery(value)).resolves.toBe(16384)
    expect(queryLimitMb).toHaveBeenCalledTimes(1)
  })

  it('keeps the error page when the backend reports the limit is already at the cap', async () => {
    const { value } = input({ queryLimitMb: async () => null })
    await expect(planHeapRecovery(value)).resolves.toBeNull()
  })

  it('leaves the error page to plugin recovery when a broken plugin was detected', async () => {
    const { value, queryLimitMb } = input({ pluginRecoveryRequired: true })
    await expect(planHeapRecovery(value)).resolves.toBeNull()
    expect(queryLimitMb).not.toHaveBeenCalled()
  })

  it('ignores exits that were not heap exhaustion', async () => {
    const { value, queryLimitMb } = input({ heapExhausted: false })
    await expect(planHeapRecovery(value)).resolves.toBeNull()
    expect(queryLimitMb).not.toHaveBeenCalled()
  })

  it('stays out of the way while a user action is in flight', async () => {
    const { value, queryLimitMb } = input({ busy: 'restart' })
    await expect(planHeapRecovery(value)).resolves.toBeNull()
    expect(queryLimitMb).not.toHaveBeenCalled()
  })

  it('falls back to the error page when the backend cannot be queried', async () => {
    const { value } = input({
      queryLimitMb: async () => {
        throw new Error('invoke failed')
      },
    })
    await expect(planHeapRecovery(value)).resolves.toBeNull()
  })
})
