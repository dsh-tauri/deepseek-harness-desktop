import type { SchedulerSchedule as Schedule, Weekday } from '../types'
import { inRange, isArray, isEmpty, isFinite, isInteger, isNil, isNumber, isObject, isString } from 'lodash-es'
import { WEEKDAYS } from '../../shared/constants'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MAX_EPOCH = 8_640_000_000_000_000
const MAX_EVERY_MINUTES = 525_600
const MAX_EVERY_DAYS = 366
const MAX_CALENDAR_ATTEMPTS = 400
const WEEKDAY_NUMBER: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 }

type CalendarSchedule = Exclude<Schedule, { kind: 'once' | 'interval' }>

const isInstant = (value: unknown): boolean => isString(value) && isFinite(new Date(value).getTime())
const isTimeValue = (value: unknown): boolean => isString(value) && parseTimeToMinutes(value) !== undefined
const isMinuteValue = (value: unknown): boolean => isNumber(value) && isInteger(value) && inRange(value, 0, 60)
const isFiniteInRange = (value: unknown, end: number): boolean => isNumber(value) && isFinite(value) && inRange(value, 1, end)
const isIntegerInRange = (value: unknown, end: number): boolean => isNumber(value) && isInteger(value) && inRange(value, 1, end)
const isEpoch = (value: number): boolean => Number.isSafeInteger(value) && isFinite(new Date(value).getTime())

export function parseTimeToMinutes(time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match)
    return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return inRange(hours, 0, 24) && inRange(minutes, 0, 60) ? hours * 60 + minutes : undefined
}

export function nextOccurrence(schedule: Schedule, from: number): number | undefined {
  if (!isEpoch(from) || !validateSchedule(schedule))
    return undefined
  switch (schedule.kind) {
    case 'once': {
      const at = new Date(schedule.at).getTime()
      return at > from ? at : undefined
    }
    case 'interval': {
      const step = schedule.everyMinutes * MINUTE_MS
      const base = isNil(schedule.anchor) ? from : new Date(schedule.anchor).getTime()
      const next = from < base ? base : from + step - intervalRemainder(from, base, step)
      return isFinite(next) && Math.abs(next) <= MAX_EPOCH && next > from ? next : undefined
    }
    default:
      return calendarOccurrence(schedule, from, 1)
  }
}

export function latestDueOccurrence(schedule: Schedule, nextRunAt: number, now: number): number | undefined {
  if (!isEpoch(nextRunAt) || !isEpoch(now) || nextRunAt > now || !validateSchedule(schedule))
    return undefined
  if (schedule.kind === 'once')
    return nextRunAt
  if (schedule.kind === 'interval') {
    const step = schedule.everyMinutes * MINUTE_MS
    return now - intervalRemainder(now, nextRunAt, step)
  }
  return Math.max(nextRunAt, calendarOccurrence(schedule, now, -1) ?? nextRunAt)
}

export function validateSchedule(schedule: unknown): schedule is Schedule {
  if (!isObject(schedule) || isArray(schedule))
    return false
  const value = schedule as Partial<Schedule>
  if (calendarFormatter(value.timeZone) === undefined)
    return false
  switch (value.kind) {
    case 'once':
      return isInstant(value.at)
    case 'hourly':
      return isMinuteValue(value.minute)
    case 'interval':
      return isFiniteInRange(value.everyMinutes, MAX_EVERY_MINUTES + 1) && (isNil(value.anchor) || isInstant(value.anchor))
    case 'custom':
      return isIntegerInRange(value.everyDays, MAX_EVERY_DAYS + 1) && isInstant(value.anchor) && isTimeValue(value.time)
    case 'daily': case 'workdays':
      return isTimeValue(value.time)
    case 'monthly':
      return isIntegerInRange(value.day, 32) && isTimeValue(value.time)
    case 'weekly':
      return isTimeValue(value.time) && isArray(value.weekdays) && !isEmpty(value.weekdays) && value.weekdays.every(day => WEEKDAYS.includes(day))
    default:
      return false
  }
}

export function localTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}

function intervalRemainder(epoch: number, base: number, step: number): number {
  return ((epoch % step - base % step) % step + step) % step
}

function calendarFormatter(timeZone: unknown): Intl.DateTimeFormat | undefined {
  if (timeZone !== undefined && (!isString(timeZone) || timeZone === '' || timeZone.trim() !== timeZone))
    return undefined
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  }
  catch {
    return undefined
  }
}

function calendarEpoch(year: number, month: number, day: number, minutes = 0, seconds = 0): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(0, minutes, seconds, 0)
  return date.getTime()
}

function zonedEpoch(formatter: Intl.DateTimeFormat, epoch: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(epoch).map(part => [part.type, part.value]))
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year)
  return calendarEpoch(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour) * 60 + Number(parts.minute), Number(parts.second))
}

function localInstant(formatter: Intl.DateTimeFormat, local: number): number | undefined {
  const offsets = new Set<number>()
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    const sample = local + delta
    if (isEpoch(sample))
      offsets.add(zonedEpoch(formatter, sample) - sample)
  }
  let earliest: number | undefined
  // issue #987: gaps fail the wall-clock round trip; overlaps use only their earlier instant.
  for (const offset of offsets) {
    const target = local - offset
    if (isEpoch(target) && zonedEpoch(formatter, target) === local && (earliest === undefined || target < earliest))
      earliest = target
  }
  return earliest
}

function calendarOccurrence(schedule: CalendarSchedule, from: number, direction: 1 | -1): number | undefined {
  const formatter = calendarFormatter(schedule.timeZone)
  if (formatter === undefined)
    return undefined
  const minutes = schedule.kind === 'hourly' ? schedule.minute : parseTimeToMinutes(schedule.time)
  if (minutes === undefined)
    return undefined
  let cursor = Math.max(-MAX_EPOCH, Math.min(MAX_EPOCH, Math.floor(from / DAY_MS) * DAY_MS - direction * DAY_MS))
  let step = schedule.kind === 'hourly' ? HOUR_MS : DAY_MS
  let anchor: number | undefined
  if (schedule.kind === 'custom') {
    anchor = new Date(schedule.anchor).getTime()
    const anchorDay = Math.floor(zonedEpoch(formatter, anchor) / DAY_MS) * DAY_MS
    step = schedule.everyDays * DAY_MS
    const index = direction === 1 ? Math.max(0, Math.ceil((cursor - anchorDay) / step)) : Math.floor((cursor - anchorDay) / step)
    if (index < 0)
      return undefined
    cursor = anchorDay + index * step
  }
  if (schedule.kind === 'monthly') {
    const date = new Date(cursor)
    cursor = calendarEpoch(date.getUTCFullYear(), date.getUTCMonth(), 1)
  }
  for (let attempt = 0; attempt < MAX_CALENDAR_ATTEMPTS && isEpoch(cursor); attempt++) {
    const date = new Date(cursor)
    const weekday = date.getUTCDay()
    const local = schedule.kind === 'monthly'
      ? calendarEpoch(date.getUTCFullYear(), date.getUTCMonth(), schedule.day, minutes)
      : cursor + minutes * MINUTE_MS
    const matches = schedule.kind === 'workdays'
      ? inRange(weekday, 1, 6)
      : schedule.kind === 'weekly'
        ? schedule.weekdays.some(day => WEEKDAY_NUMBER[day] === weekday)
        : schedule.kind === 'monthly'
          ? new Date(local).getUTCMonth() === date.getUTCMonth()
          : true
    if (matches) {
      const target = localInstant(formatter, local)
      if (target !== undefined && (anchor === undefined || target >= anchor) && (direction === 1 ? target > from : target <= from))
        return target
    }
    cursor = schedule.kind === 'monthly'
      ? calendarEpoch(date.getUTCFullYear(), date.getUTCMonth() + direction, 1)
      : cursor + direction * step
  }
  return undefined
}
