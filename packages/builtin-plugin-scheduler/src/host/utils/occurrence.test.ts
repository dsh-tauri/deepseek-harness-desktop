import type { SchedulerSchedule } from '../types'
import { describe, expect, it } from 'vitest'
import { nextFutureOccurrence } from './occurrence'

const instant = (value: string): number => Date.parse(value)

describe('durable occurrence advancement', () => {
  it('keeps a durable interval phase instead of reapplying the configured anchor', () => {
    const rule: SchedulerSchedule = { kind: 'interval', everyMinutes: 15, anchor: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' }
    expect(nextFutureOccurrence(rule, instant('2026-06-01T00:47:17.000Z'), instant('2026-06-01T00:59:00.000Z'))).toBe(instant('2026-06-01T01:02:17.000Z'))
  })

  it('skips intervals that elapsed while the accepted occurrence was completing', () => {
    const rule: SchedulerSchedule = { kind: 'interval', everyMinutes: 15, anchor: '2026-06-01T00:00:00.000Z', timeZone: 'UTC' }
    expect(nextFutureOccurrence(rule, instant('2026-06-01T00:47:17.000Z'), instant('2026-06-01T01:32:17.000Z'))).toBe(instant('2026-06-01T01:47:17.000Z'))
  })

  it('cannot repeat a committed occurrence after the wall clock rolls back', () => {
    expect(nextFutureOccurrence({ kind: 'daily', time: '12:00', timeZone: 'UTC' }, instant('2026-06-01T12:00:00.000Z'), instant('2026-05-31T12:00:00.000Z'))).toBe(instant('2026-06-02T12:00:00.000Z'))
  })

  it('folds elapsed calendar slots before selecting the strictly future target', () => {
    expect(nextFutureOccurrence({ kind: 'daily', time: '12:00', timeZone: 'UTC' }, instant('2026-06-01T12:00:00.000Z'), instant('2026-06-05T12:00:00.000Z'))).toBe(instant('2026-06-06T12:00:00.000Z'))
  })

  it('leaves a consumed one-off terminal even if its configured time is later', () => {
    expect(nextFutureOccurrence({ kind: 'once', at: '2026-07-01T12:00:00.000Z', timeZone: 'UTC' }, instant('2026-06-01T12:00:00.000Z'), instant('2026-06-01T12:15:00.000Z'))).toBeUndefined()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001, 1.5])('rejects an invalid epoch without throwing: %s', (invalid) => {
    const rule: SchedulerSchedule = { kind: 'interval', everyMinutes: 15, timeZone: 'UTC' }
    expect(nextFutureOccurrence(rule, invalid, 0)).toBeUndefined()
    expect(nextFutureOccurrence(rule, 0, invalid)).toBeUndefined()
  })
})
