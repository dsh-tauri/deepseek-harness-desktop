import type { SchedulerSchedule as Schedule } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestDueOccurrence, nextOccurrence, parseTimeToMinutes, validateSchedule } from './schedule'

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const timestamp = (value: string): number => Date.parse(value)

const CALENDAR_CASES: Array<[Schedule, string, string]> = [
  [{ kind: 'daily', time: '08:00', timeZone: 'UTC' }, '2026-01-01T07:00:00Z', '2026-01-01T08:00:00Z'],
  [{ kind: 'daily', time: '08:00', timeZone: 'UTC' }, '2026-01-01T08:00:00Z', '2026-01-02T08:00:00Z'],
  [{ kind: 'workdays', time: '08:00', timeZone: 'UTC' }, '2026-01-03T09:00:00Z', '2026-01-05T08:00:00Z'],
  [{ kind: 'weekly', weekdays: ['MO', 'WE', 'MO'], time: '08:00', timeZone: 'UTC' }, '2026-01-01T09:00:00Z', '2026-01-05T08:00:00Z'],
  [{ kind: 'monthly', day: 15, time: '08:00', timeZone: 'UTC' }, '2026-01-10T00:00:00Z', '2026-01-15T08:00:00Z'],
  [{ kind: 'monthly', day: 15, time: '08:00', timeZone: 'UTC' }, '2026-01-20T00:00:00Z', '2026-02-15T08:00:00Z'],
  [{ kind: 'monthly', day: 31, time: '08:00', timeZone: 'UTC' }, '2026-02-01T00:00:00Z', '2026-03-31T08:00:00Z'],
  [{ kind: 'monthly', day: 29, time: '08:00', timeZone: 'UTC' }, '2028-02-01T00:00:00Z', '2028-02-29T08:00:00Z'],
]

const ZONED_CASES: Array<[Schedule, string, string]> = [
  [{ kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' }, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
  [{ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, '2026-01-01T07:00:00Z', '2026-01-01T13:00:00Z'],
  [{ kind: 'daily', time: '08:00', timeZone: 'Asia/Tokyo' }, '2026-01-01T01:00:00Z', '2026-01-01T23:00:00Z'],
  [{ kind: 'hourly', minute: 30, timeZone: 'Asia/Kathmandu' }, '2026-01-01T04:55:00Z', '2026-01-01T05:45:00Z'],
  [{ kind: 'workdays', time: '08:00', timeZone: 'Asia/Tokyo' }, '2026-01-04T22:30:00Z', '2026-01-04T23:00:00Z'],
  [{ kind: 'weekly', weekdays: ['SU'], time: '22:00', timeZone: 'America/New_York' }, '2026-01-05T02:00:00Z', '2026-01-05T03:00:00Z'],
  [{ kind: 'monthly', day: 1, time: '08:00', timeZone: 'Asia/Tokyo' }, '2026-01-31T16:00:00Z', '2026-01-31T23:00:00Z'],
  [{ kind: 'custom', everyDays: 2, anchor: '2026-01-01T23:30:00Z', time: '09:00', timeZone: 'Asia/Tokyo' }, '2026-01-01T23:30:00Z', '2026-01-02T00:00:00Z'],
]

const DST_CASES: Array<[Schedule, string, string]> = [
  [{ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, '2026-03-07T14:00:00Z', '2026-03-08T12:00:00Z'],
  [{ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, '2026-10-31T13:00:00Z', '2026-11-01T13:00:00Z'],
  [{ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, '2026-03-07T07:30:00Z', '2026-03-09T06:30:00Z'],
  [{ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, '2026-03-08T05:00:00Z', '2026-03-09T06:30:00Z'],
  [{ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z'],
  [{ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, '2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
  [{ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, '2026-11-01T06:00:00Z', '2026-11-02T06:30:00Z'],
  [{ kind: 'workdays', time: '08:00', timeZone: 'America/New_York' }, '2026-03-06T15:00:00Z', '2026-03-09T12:00:00Z'],
  [{ kind: 'weekly', weekdays: ['SU'], time: '02:30', timeZone: 'America/New_York' }, '2026-03-01T07:30:00Z', '2026-03-15T06:30:00Z'],
  [{ kind: 'monthly', day: 8, time: '02:30', timeZone: 'America/New_York' }, '2026-03-01T00:00:00Z', '2026-04-08T06:30:00Z'],
  [{ kind: 'custom', everyDays: 1, anchor: '2026-03-07T05:00:00Z', time: '02:30', timeZone: 'America/New_York' }, '2026-03-07T07:30:00Z', '2026-03-09T06:30:00Z'],
  [{ kind: 'custom', everyDays: 2, anchor: '2026-03-07T05:00:00Z', time: '08:00', timeZone: 'America/New_York' }, '2026-03-07T13:00:00Z', '2026-03-09T12:00:00Z'],
  [{ kind: 'custom', everyDays: 1, anchor: '2026-10-31T04:00:00Z', time: '08:00', timeZone: 'America/New_York' }, '2026-10-31T12:00:00Z', '2026-11-01T13:00:00Z'],
  [{ kind: 'hourly', minute: 30, timeZone: 'America/New_York' }, '2026-03-08T06:45:00Z', '2026-03-08T07:30:00Z'],
  [{ kind: 'hourly', minute: 30, timeZone: 'America/New_York' }, '2026-11-01T05:40:00Z', '2026-11-01T07:30:00Z'],
  [{ kind: 'hourly', minute: 30, timeZone: 'America/New_York' }, '2026-11-01T06:10:00Z', '2026-11-01T07:30:00Z'],
  [{ kind: 'daily', time: '02:15', timeZone: 'Australia/Lord_Howe' }, '2026-10-03T15:00:00Z', '2026-10-04T15:15:00Z'],
  [{ kind: 'daily', time: '01:45', timeZone: 'Australia/Lord_Howe' }, '2026-04-04T13:00:00Z', '2026-04-04T14:45:00Z'],
  [{ kind: 'daily', time: '12:00', timeZone: 'Pacific/Apia' }, '2011-12-29T22:00:00Z', '2011-12-30T22:00:00Z'],
  [{ kind: 'custom', everyDays: 2, anchor: '2011-12-29T10:00:00Z', time: '12:00', timeZone: 'Pacific/Apia' }, '2011-12-29T22:00:00Z', '2011-12-30T22:00:00Z'],
]

const INVALID_SCHEDULES = [
  { kind: 'once', at: 'not-a-date', timeZone: 'UTC' },
  { kind: 'hourly', minute: -1, timeZone: 'UTC' },
  { kind: 'hourly', minute: 60, timeZone: 'UTC' },
  { kind: 'hourly', minute: 1.5, timeZone: 'UTC' },
  { kind: 'interval', everyMinutes: 0, timeZone: 'UTC' },
  { kind: 'interval', everyMinutes: 1e9, timeZone: 'UTC' },
  { kind: 'interval', everyMinutes: 30, anchor: 'bad', timeZone: 'UTC' },
  { kind: 'daily', time: 'bad', timeZone: 'UTC' },
  { kind: 'workdays', time: '24:00', timeZone: 'UTC' },
  { kind: 'weekly', weekdays: [], time: '08:00', timeZone: 'UTC' },
  { kind: 'weekly', weekdays: ['XX'], time: '08:00', timeZone: 'UTC' },
  { kind: 'monthly', day: 0, time: '08:00', timeZone: 'UTC' },
  { kind: 'monthly', day: 32, time: '08:00', timeZone: 'UTC' },
  { kind: 'custom', everyDays: 0, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' },
  { kind: 'custom', everyDays: 367, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' },
  { kind: 'custom', everyDays: 1.5, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' },
  { kind: 'custom', everyDays: 2, anchor: 'bad', time: '08:00', timeZone: 'UTC' },
  { kind: 'custom', everyDays: 2, anchor: '2026-01-01T00:00:00Z', time: 'bad', timeZone: 'UTC' },
  { kind: 'daily', time: '08:00', timeZone: 'Unknown/Zone' },
]

describe('parseTimeToMinutes', () => {
  it.each([
    ['00:00', 0],
    ['08:30', 510],
    ['23:59', 1439],
    [' 8:30 ', 510],
  ])('parses %s into %i minutes since midnight', (input, expected) => {
    expect(parseTimeToMinutes(input)).toBe(expected)
  })

  it.each(['', '8', '24:00', '08:60', 'ab:cd'])('rejects invalid clock input %s', (input) => {
    expect(parseTimeToMinutes(input)).toBeUndefined()
  })
})

describe('nextOccurrence', () => {
  it('starts an unanchored interval one full interval after from', () => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 30, timeZone: 'UTC' }, timestamp('2026-01-01T08:11:00Z')))
      .toBe(timestamp('2026-01-01T08:41:00Z'))
  })

  it('treats a null optional interval anchor as unanchored input', () => {
    const schedule = { kind: 'interval', everyMinutes: 30, anchor: null, timeZone: 'UTC' }
    expect(nextOccurrence(schedule as unknown as Schedule, timestamp('2026-01-01T08:11:00Z')))
      .toBe(timestamp('2026-01-01T08:41:00Z'))
  })

  it.each([
    ['2025-12-31T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'],
    ['2026-01-01T00:46:00Z', '2026-01-01T01:00:00Z'],
  ])('keeps interval anchor phase when from is %s', (from, expected) => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 30, anchor: '2026-01-01T00:00:00Z', timeZone: 'UTC' }, timestamp(from)))
      .toBe(timestamp(expected))
  })

  it('returns a future instant for a valid interval with a sub-millisecond step fraction', () => {
    const schedule: Schedule = { kind: 'interval', everyMinutes: 1.00001, timeZone: 'UTC' }
    expect(validateSchedule(schedule)).toBe(true)
    expect(nextOccurrence(schedule, timestamp('2026-01-01T00:00:00Z')))
      .toBe(timestamp('2026-01-01T00:00:00Z') + 60_000.6)
  })

  it('retains a supported fractional-minute interval and its millisecond anchor', () => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 1.5, anchor: '2026-01-01T00:00:00.123Z', timeZone: 'America/New_York' }, timestamp('2026-01-01T00:01:00Z')))
      .toBe(timestamp('2026-01-01T00:01:30.123Z'))
  })

  it('finds an anchored interval target without losing a millisecond across the full date range', () => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 1, anchor: '-271821-04-20T00:00:00.000Z', timeZone: 'UTC' }, 8_639_999_999_999_999))
      .toBe(8_640_000_000_000_000)
  })

  it('keeps once as an absolute instant regardless of its zone', () => {
    const schedule: Schedule = { kind: 'once', at: '2026-03-01T12:30:00Z', timeZone: 'Asia/Tokyo' }
    expect(nextOccurrence(schedule, timestamp('2026-03-01T12:29:59.999Z'))).toBe(timestamp('2026-03-01T12:30:00Z'))
    expect(nextOccurrence(schedule, timestamp('2026-03-01T12:30:00Z'))).toBeUndefined()
    expect(nextOccurrence(schedule, timestamp('2027-01-01T00:00:00Z'))).toBeUndefined()
  })

  it.each([
    [30, '2026-01-01T08:10:00Z', '2026-01-01T08:30:00Z'],
    [30, '2026-01-01T08:45:00Z', '2026-01-01T09:30:00Z'],
    [30, '2026-01-01T08:29:59.999Z', '2026-01-01T08:30:00Z'],
    [0, '2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z'],
    [0, '2026-01-01T08:59:59.999Z', '2026-01-01T09:00:00Z'],
  ])('selects the next local minute %i after %s', (minute, from, expected) => {
    expect(nextOccurrence({ kind: 'hourly', minute, timeZone: 'UTC' }, timestamp(from))).toBe(timestamp(expected))
  })

  it.each(CALENDAR_CASES)('selects %j strictly after %s', (schedule, from, expected) => {
    expect(nextOccurrence(schedule, timestamp(from))).toBe(timestamp(expected))
  })

  it.each(ZONED_CASES)('uses the rule zone for %j after %s despite the host zone', (schedule, from, expected) => {
    vi.stubEnv('TZ', 'Pacific/Honolulu')
    expect(nextOccurrence(schedule, timestamp(from))).toBe(timestamp(expected))
  })

  it.each([
    ['2025-12-20T00:00:00Z', '2026-01-01T08:00:00Z'],
    ['2026-01-01T07:00:00Z', '2026-01-01T08:00:00Z'],
    ['2026-01-01T09:00:00Z', '2026-01-03T08:00:00Z'],
    ['2026-01-03T08:00:00Z', '2026-01-05T08:00:00Z'],
  ])('applies custom time to anchor-aligned dates after %s', (from, expected) => {
    expect(nextOccurrence({ kind: 'custom', everyDays: 2, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' }, timestamp(from)))
      .toBe(timestamp(expected))
  })

  it('includes an anchor-aligned custom time when the decision precedes the exact anchor instant', () => {
    expect(nextOccurrence({ kind: 'custom', everyDays: 2, anchor: '2026-01-01T08:00:00Z', time: '08:00', timeZone: 'UTC' }, timestamp('2026-01-01T07:59:59.999Z')))
      .toBe(timestamp('2026-01-01T08:00:00Z'))
  })

  it('bases custom phase on the anchor local date even when it is behind the UTC date', () => {
    expect(nextOccurrence({ kind: 'custom', everyDays: 2, anchor: '2026-01-02T01:00:00Z', time: '18:00', timeZone: 'America/Los_Angeles' }, timestamp('2026-01-02T01:00:00Z')))
      .toBe(timestamp('2026-01-02T02:00:00Z'))
  })

  it('never places the first custom occurrence before the anchor instant', () => {
    expect(nextOccurrence({ kind: 'custom', everyDays: 2, anchor: '2026-01-01T10:00:00Z', time: '08:00', timeZone: 'UTC' }, timestamp('2025-12-20T00:00:00Z')))
      .toBe(timestamp('2026-01-03T08:00:00Z'))
  })

  it('advances a maximal 366-day custom cadence without walking every intervening date', () => {
    expect(nextOccurrence({ kind: 'custom', everyDays: 366, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' }, timestamp('2026-01-01T08:00:00Z')))
      .toBe(timestamp('2027-01-02T08:00:00Z'))
  })

  it.each(DST_CASES)('keeps wall-clock and earlier-overlap semantics for %j after %s', (schedule, from, expected) => {
    expect(nextOccurrence(schedule, timestamp(from))).toBe(timestamp(expected))
  })

  it('does not reinterpret calendar years below 100 as 1900-based years', () => {
    expect(nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, timestamp('0099-12-31T09:00:00Z')))
      .toBe(timestamp('0100-01-01T08:00:00Z'))
  })

  it.each(INVALID_SCHEDULES)('returns undefined instead of throwing for invalid rule %j', (schedule) => {
    expect(nextOccurrence(schedule as Schedule, timestamp('2026-01-01T00:00:00Z'))).toBeUndefined()
  })

  it('selects a UTC daily target after the earliest representable decision', () => {
    expect(nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, -8_640_000_000_000_000))
      .toBe(-8_639_999_971_200_000)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('rejects unrepresentable from %s', (from) => {
    expect(nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, from)).toBeUndefined()
  })
})

describe('latestDueOccurrence', () => {
  it('does not invent a due occurrence before the durable target', () => {
    expect(latestDueOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, timestamp('2026-01-01T08:00:00Z'), timestamp('2026-01-01T07:59:59.999Z')))
      .toBeUndefined()
  })

  it('retains the single one-shot target after a long missed gap', () => {
    const schedule: Schedule = { kind: 'once', at: '2000-01-01T08:00:00Z', timeZone: 'Asia/Tokyo' }
    const due = latestDueOccurrence(schedule, timestamp('2000-01-01T08:00:00Z'), timestamp('2099-12-31T23:59:59Z'))
    expect(due).toBe(timestamp('2000-01-01T08:00:00Z'))
    expect(nextOccurrence(schedule, timestamp('2000-01-01T08:00:00Z'))).toBeUndefined()
  })

  it('folds centuries of interval misses while preserving durable millisecond phase', () => {
    expect(latestDueOccurrence({ kind: 'interval', everyMinutes: 5, timeZone: 'UTC' }, timestamp('1800-01-01T00:00:00.123Z'), timestamp('2026-01-01T00:17:34.456Z')))
      .toBe(timestamp('2026-01-01T00:15:00.123Z'))
  })

  it('uses durable nextRunAt rather than a recomputed interval anchor', () => {
    expect(latestDueOccurrence({ kind: 'interval', everyMinutes: 15, anchor: '2026-01-01T00:00:00Z', timeZone: 'UTC' }, timestamp('2026-01-01T00:02:17Z'), timestamp('2026-01-01T00:59:00Z')))
      .toBe(timestamp('2026-01-01T00:47:17Z'))
  })

  it('folds fractional-minute misses from the committed millisecond target', () => {
    expect(latestDueOccurrence({ kind: 'interval', everyMinutes: 1.5, timeZone: 'UTC' }, timestamp('2026-01-01T00:00:00.123Z'), timestamp('2026-01-01T00:05:00Z')))
      .toBe(timestamp('2026-01-01T00:04:30.123Z'))
  })

  it('retains interval phase across the full date range without rounding the decision forward', () => {
    expect(latestDueOccurrence({ kind: 'interval', everyMinutes: 1, timeZone: 'UTC' }, -8_640_000_000_000_000, 8_639_999_999_999_999))
      .toBe(8_639_999_999_940_000)
  })

  it.each<[Schedule, string, string, string]>([
    [{ kind: 'hourly', minute: 30, timeZone: 'Asia/Kathmandu' }, '1800-01-01T00:00:00Z', '2026-01-01T04:55:00Z', '2026-01-01T04:45:00Z'],
    [{ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, '1800-01-01T00:00:00Z', '2026-09-16T00:59:59Z', '2026-09-15T01:00:00Z'],
    [{ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, '1800-01-01T00:00:00Z', '2026-09-16T01:00:00Z', '2026-09-16T01:00:00Z'],
    [{ kind: 'workdays', time: '09:00', timeZone: 'UTC' }, '1800-01-01T00:00:00Z', '2026-01-03T12:00:00Z', '2026-01-02T09:00:00Z'],
    [{ kind: 'weekly', weekdays: ['MO', 'FR'], time: '09:00', timeZone: 'America/New_York' }, '1800-01-01T00:00:00Z', '2026-01-08T12:00:00Z', '2026-01-05T14:00:00Z'],
    [{ kind: 'monthly', day: 31, time: '08:00', timeZone: 'Asia/Tokyo' }, '1800-01-01T00:00:00Z', '2026-03-01T02:00:00Z', '2026-01-30T23:00:00Z'],
    [{ kind: 'custom', everyDays: 7, anchor: '2000-01-03T00:00:00Z', time: '08:00', timeZone: 'UTC' }, '2000-01-03T08:00:00Z', '2026-01-09T09:00:00Z', '2026-01-05T08:00:00Z'],
    [{ kind: 'custom', everyDays: 2, anchor: '1970-01-01T06:00:00Z', time: '08:00', timeZone: 'UTC' }, '1970-01-01T08:00:00Z', '2026-01-01T09:00:00Z', '2026-01-01T08:00:00Z'],
  ])('selects only the latest missed target for %j at %s', (schedule, nextRunAt, now, expected) => {
    expect(latestDueOccurrence(schedule, timestamp(nextRunAt), timestamp(now))).toBe(timestamp(expected))
  })

  it.each<[Schedule, string, string, string]>([
    [{ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, '2026-03-07T07:30:00Z', '2026-03-08T12:00:00Z', '2026-03-07T07:30:00Z'],
    [{ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, '2026-03-07T07:30:00Z', '2026-03-09T07:00:00Z', '2026-03-09T06:30:00Z'],
    [{ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, '2026-10-31T05:30:00Z', '2026-11-01T06:45:00Z', '2026-11-01T05:30:00Z'],
    [{ kind: 'hourly', minute: 30, timeZone: 'America/New_York' }, '2026-10-31T04:30:00Z', '2026-11-01T06:15:00Z', '2026-11-01T05:30:00Z'],
    [{ kind: 'custom', everyDays: 2, anchor: '2011-12-29T10:00:00Z', time: '12:00', timeZone: 'Pacific/Apia' }, '2011-12-29T22:00:00Z', '2011-12-30T23:00:00Z', '2011-12-30T22:00:00Z'],
    [{ kind: 'daily', time: '12:00', timeZone: 'America/Anchorage' }, '1867-10-17T21:59:36Z', '1867-10-19T06:00:00Z', '1867-10-18T21:59:36Z'],
  ])('folds missed DST/date-line targets for %j at %s', (schedule, nextRunAt, now, expected) => {
    expect(latestDueOccurrence(schedule, timestamp(nextRunAt), timestamp(now))).toBe(timestamp(expected))
  })

  it('honors a committed later-overlap target instead of rewinding it under current rules', () => {
    expect(latestDueOccurrence({ kind: 'daily', time: '01:30', timeZone: 'US/Eastern' }, timestamp('2026-11-01T06:30:00Z'), timestamp('2026-11-01T06:45:00Z')))
      .toBe(timestamp('2026-11-01T06:30:00Z'))
  })

  it('retains the committed custom target when the next phase has not arrived', () => {
    expect(latestDueOccurrence({ kind: 'custom', everyDays: 366, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' }, timestamp('2026-01-01T08:00:00Z'), timestamp('2026-12-31T23:00:00Z')))
      .toBe(timestamp('2026-01-01T08:00:00Z'))
  })

  it('finds the UTC calendar target at the final representable decision', () => {
    expect(latestDueOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, timestamp('2000-01-01T08:00:00Z'), 8_640_000_000_000_000))
      .toBe(8_639_999_942_400_000)
  })

  it('bounds calendar projection work independently of the missed history length', () => {
    const projection = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    expect(latestDueOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, timestamp('0001-01-01T00:00:00Z'), timestamp('9999-12-31T02:00:00Z')))
      .toBe(timestamp('9999-12-31T01:00:00Z'))
    expect(projection.mock.calls.length).toBeLessThan(100)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('rejects an unrepresentable durable target or decision %s', (invalid) => {
    const schedule: Schedule = { kind: 'daily', time: '08:00', timeZone: 'UTC' }
    expect(latestDueOccurrence(schedule, invalid, timestamp('2026-01-01T09:00:00Z'))).toBeUndefined()
    expect(latestDueOccurrence(schedule, timestamp('2026-01-01T08:00:00Z'), invalid)).toBeUndefined()
  })

  it('rejects an invalid recurrence instead of replaying its durable target', () => {
    expect(latestDueOccurrence({ kind: 'interval', everyMinutes: 0, timeZone: 'UTC' }, timestamp('2026-01-01T00:00:00Z'), timestamp('2026-01-02T00:00:00Z')))
      .toBeUndefined()
  })
})

describe('validateSchedule', () => {
  it.each<Schedule>([
    { kind: 'once', at: '2026-01-01T08:00:00Z', timeZone: 'UTC' },
    { kind: 'hourly', minute: 0, timeZone: 'UTC' },
    { kind: 'hourly', minute: 59, timeZone: 'UTC' },
    { kind: 'daily', time: '08:00', timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 30, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 1.5, anchor: '2026-01-01T00:00:00Z', timeZone: 'UTC' },
    { kind: 'workdays', time: '09:30', timeZone: 'UTC' },
    { kind: 'weekly', weekdays: ['MO', 'FR'], time: '10:00', timeZone: 'UTC' },
    { kind: 'monthly', day: 31, time: '08:00', timeZone: 'UTC' },
    { kind: 'custom', everyDays: 366, anchor: '2026-01-01T00:00:00Z', time: '08:00', timeZone: 'UTC' },
  ])('accepts a valid %j schedule', (schedule) => {
    expect(validateSchedule(schedule)).toBe(true)
  })

  it('allows an omitted input zone before host normalization', () => {
    expect(validateSchedule({ kind: 'daily', time: '08:00' })).toBe(true)
  })

  it('accepts a recognized IANA alias without rewriting the schedule', () => {
    const schedule = { kind: 'daily', time: '08:00', timeZone: 'US/Eastern' }
    expect(validateSchedule(schedule)).toBe(true)
    expect(schedule.timeZone).toBe('US/Eastern')
  })

  it.each(INVALID_SCHEDULES)('rejects invalid rule %j', (schedule) => {
    expect(validateSchedule(schedule)).toBe(false)
  })

  it.each([null, 'nope', [], { kind: 'unknown' }, { kind: 'once', at: 1735689600000 }])('rejects invalid shape %j', (value) => {
    expect(validateSchedule(value)).toBe(false)
  })

  it.each(['', 'UTC ', ' Asia/Shanghai', 7, null])('rejects invalid explicit zone %j', (timeZone) => {
    expect(validateSchedule({ kind: 'daily', time: '08:00', timeZone })).toBe(false)
  })
})
