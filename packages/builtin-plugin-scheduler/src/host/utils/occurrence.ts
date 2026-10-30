import type { SchedulerSchedule } from '../types'
import { nextOccurrence } from './schedule'

export function nextFutureOccurrence(schedule: SchedulerSchedule, scheduledAt: number, now: number): number | undefined {
  if (!Number.isSafeInteger(scheduledAt) || !Number.isFinite(new Date(scheduledAt).getTime())
    || !Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()) || schedule.kind === 'once') {
    return undefined
  }
  const from = Math.max(scheduledAt, now)
  const rule = schedule.kind === 'interval' ? { ...schedule, anchor: new Date(scheduledAt).toISOString() } : schedule
  return nextOccurrence(rule, from)
}
