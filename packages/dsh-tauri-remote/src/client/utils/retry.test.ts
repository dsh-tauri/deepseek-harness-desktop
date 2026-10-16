import { describe, expect, it } from 'vitest'
import { retrySecondsOf } from './retry'

describe('retrySecondsOf', () => {
  const now = 1_700_000_000_000

  it('rounds a partial remaining second up to a full one', () => {
    expect(retrySecondsOf(now + 8_000, now)).toBe(8)
    expect(retrySecondsOf(now + 7_001, now)).toBe(8)
    expect(retrySecondsOf(now + 7_000, now)).toBe(7)
  })

  it('reads zero for a retry that is due now or already overdue', () => {
    expect(retrySecondsOf(now, now)).toBe(0)
    expect(retrySecondsOf(now - 5_000, now)).toBe(0)
  })
})
