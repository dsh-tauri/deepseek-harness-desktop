import type { TaskView } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value)
    return false
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone !== ''
  }
  catch {
    return false
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isSchedule(value: unknown): value is TaskView['schedule'] {
  if (!isRecord(value) || !isTimeZone(value.timeZone))
    return false
  switch (value.kind) {
    case 'once':
      return isTimestamp(value.at)
    case 'hourly':
      return typeof value.minute === 'number' && Number.isInteger(value.minute) && value.minute >= 0 && value.minute <= 59
    case 'daily':
    case 'workdays':
      return isTime(value.time)
    case 'weekly':
      return isTime(value.time) && Array.isArray(value.weekdays) && value.weekdays.length > 0
        && value.weekdays.every(day => ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(day))
    case 'monthly':
      return isTime(value.time) && isPositiveInteger(value.day) && value.day <= 31
    case 'interval':
      return typeof value.everyMinutes === 'number' && Number.isFinite(value.everyMinutes)
        && value.everyMinutes >= 1 && value.everyMinutes < 525_601 && (value.anchor === undefined || isTimestamp(value.anchor))
    case 'custom':
      return isTime(value.time) && isPositiveInteger(value.everyDays) && value.everyDays <= 366 && isTimestamp(value.anchor)
    default:
      return false
  }
}

function isTask(value: unknown): value is TaskView {
  if (!isRecord(value))
    return false
  return typeof value.id === 'string' && value.id.trim() !== ''
    && typeof value.name === 'string' && value.name.trim() !== ''
    && typeof value.prompt === 'string' && value.prompt.trim() !== ''
    && typeof value.enabled === 'boolean'
    && (value.delivery === 'this-session' || value.delivery === 'new-session')
    && (value.status === 'active' || value.status === 'inactive')
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && isSchedule(value.schedule)
    && ['recommendationId', 'workspaceId', 'permission', 'provider', 'model', 'reasoningEffort', 'module', 'agentPreset']
      .every(key => value[key] === undefined || typeof value[key] === 'string')
      && ['lastRunAt', 'nextRunAt'].every(key => value[key] === undefined || isTimestamp(value[key]))
      && (value.waiting === undefined || typeof value.waiting === 'boolean')
}

export function decodeCreatedTask(content: readonly { type: string, text?: string }[]): TaskView | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text' || !content[0].text?.trim())
    return undefined
  try {
    const value: unknown = JSON.parse(content[0].text)
    if (!isRecord(value) || value.ok !== true || !isTask(value.task))
      return undefined
    if (value.taskId !== undefined && value.taskId !== value.task.id)
      return undefined
    return value.task
  }
  catch {
    return undefined
  }
}
