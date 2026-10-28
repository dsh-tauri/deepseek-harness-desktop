import type { LocaleKey, Translate } from '../locales/index.types'
import type { ScheduleForm, Weekday } from '../types'
import { differenceInDays, differenceInHours, differenceInMinutes, format } from 'dsh-tauri/client'

const WEEKDAY_LABELS: Record<Weekday, LocaleKey> = {
  MO: 'dayMon',
  TU: 'dayTue',
  WE: 'dayWed',
  TH: 'dayThu',
  FR: 'dayFri',
  SA: 'daySat',
  SU: 'daySun',
}

export function describeSchedule(schedule: ScheduleForm, t: Translate): string {
  switch (schedule.kind) {
    case 'once':
      return `${t('scheduleOnce')} ${formatLocalTime(schedule.at) ?? schedule.at}`
    case 'hourly':
      return `${t('scheduleHourly')} :${String(schedule.minute).padStart(2, '0')}`
    case 'daily':
      return `${t('scheduleDaily')} ${schedule.time}`
    case 'interval':
      return `${t('scheduleInterval')} ${schedule.everyMinutes}${t('minuteShort')}`
    case 'monthly':
      return `${t('scheduleMonthly')} ${schedule.day} ${schedule.time}`
    case 'custom':
      return `${t('scheduleCustom')} ${schedule.everyDays}${t('dayShort')} ${schedule.time}`
    case 'cron':
      return `${t('scheduleCron')} ${schedule.expression}`
    case 'workdays':
      return `${t('scheduleWorkdays')} ${schedule.time}`
    case 'weekly':
      return `${schedule.weekdays.map(day => t(WEEKDAY_LABELS[day])).join('/')} ${schedule.time}`
  }
}

export function formatLocalTime(iso: string | undefined): string | undefined {
  if (!iso)
    return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return undefined
  return format(date, 'MM/dd HH:mm')
}

export function formatRelative(iso: string | undefined, now: number, t: Translate): string {
  if (!iso)
    return t('never')
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target))
    return t('never')
  const minutes = Math.max(0, differenceInMinutes(target, now))
  if (minutes < 60)
    return `${minutes}${t('unitMinutes')}`
  const hours = Math.max(0, differenceInHours(target, now))
  if (hours < 24)
    return `${hours}${t('unitHours')}`
  const days = Math.max(0, differenceInDays(target, now))
  return `${days}${t('unitDays')}`
}

/**
 * 未播种（`readAt === 0`）一律按已读处理，避免首屏闪出一片未读角标。
 *
 * `readIds` 给默认值：dev 热更新下 store 可能还是加字段之前的旧实例。
 */
export function isRunUnread(run: { id: string, startedAt: string }, readAt: number, readIds: readonly string[] = []): boolean {
  return readAt !== 0 && Date.parse(run.startedAt) > readAt && !readIds.includes(run.id)
}

export function countUnreadRuns(runs: readonly { id: string, startedAt: string }[], readAt: number, readIds: readonly string[] = []): number {
  return readAt === 0 ? 0 : runs.filter(run => isRunUnread(run, readAt, readIds)).length
}
