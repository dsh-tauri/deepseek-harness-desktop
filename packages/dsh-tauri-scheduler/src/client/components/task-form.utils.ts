import type { ScheduleForm, SchedulerOptions, TaskFormState, TaskInput, TaskView } from '../types'
import { cloneDeep } from 'dsh-tauri/client'

const DAY_MS = 86_400_000

export function defaultScheduleFor(kind: ScheduleForm['kind'], timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone): ScheduleForm {
  switch (kind) {
    case 'once': return { kind, at: new Date(Date.now() + 3_600_000).toISOString(), timeZone }
    case 'hourly': return { kind, minute: 0, timeZone }
    case 'interval': return { kind, everyMinutes: 30, timeZone }
    case 'monthly': return { kind, day: 1, time: '09:00', timeZone }
    case 'custom': return { kind, everyDays: 2, time: '09:00', timeZone }
    case 'weekly': return { kind, weekdays: ['MO'], time: '09:00', timeZone }
    case 'workdays': return { kind, time: '09:00', timeZone }
    default: return { kind: 'daily', time: '09:00', timeZone }
  }
}

export function emptyTaskForm(options: SchedulerOptions, sessionId = ''): TaskFormState {
  return {
    delivery: 'new-session',
    sessionId,
    enabled: true,
    name: '',
    prompt: '',
    schedule: defaultScheduleFor('daily'),
    workspaceId: '',
    permission: options.defaultPermission || 'read-only',
    provider: options.defaultModel?.provider ?? '',
    model: options.defaultModel?.model ?? '',
    reasoningEffort: options.defaultModel?.reasoning?.defaultEffort ?? '',
  }
}

export function taskToForm(task: TaskView): TaskFormState {
  return {
    delivery: task.delivery,
    sessionId: task.sessionId ?? '',
    enabled: task.enabled,
    recommendationId: task.recommendationId,
    name: task.name,
    schedule: cloneDeep(task.schedule),
    prompt: task.prompt,
    workspaceId: task.workspaceId ?? '',
    permission: task.permission ?? 'read-only',
    provider: task.provider ?? '',
    model: task.model ?? '',
    reasoningEffort: task.reasoningEffort ?? '',
  }
}

export function taskFormInput(form: TaskFormState, editing: boolean): TaskInput {
  const input: TaskInput = {
    delivery: form.delivery,
    name: form.name,
    prompt: form.prompt,
    schedule: cloneDeep(form.schedule),
    enabled: form.enabled,
    recommendationId: form.recommendationId,
  }
  if (form.delivery === 'this-session') {
    input.sessionId = form.sessionId
    if (editing)
      Object.assign(input, { workspaceId: '', permission: '', provider: '', model: '', reasoningEffort: '' })
  }
  else {
    Object.assign(input, {
      sessionId: editing ? '' : undefined,
      workspaceId: form.workspaceId,
      permission: form.permission,
      provider: form.provider,
      model: form.model,
      reasoningEffort: form.reasoningEffort,
    })
  }
  return input
}

function wallClock(epoch: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(epoch)
    const at = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
    return `${at('year').padStart(4, '0')}-${at('month')}-${at('day')}T${at('hour')}:${at('minute')}:${at('second')}`
  }
  catch {
    return ''
  }
}

export function localDateTime(at: string, timeZone?: string): string {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime()))
    return ''
  const wall = wallClock(date.getTime(), timeZone)
  return wall && date.getUTCMilliseconds() ? `${wall}.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : wall
}

export function absoluteDateTime(value: string, timeZone?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  if (!match)
    return ''
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(part => Number(part ?? '00'))
  const calendar = new Date(0)
  calendar.setUTCFullYear(y, mo - 1, d)
  calendar.setUTCHours(h, mi, s, 0)
  if (h > 23 || mi > 59 || s > 59
    || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d
    || calendar.getUTCHours() !== h || calendar.getUTCMinutes() !== mi || calendar.getUTCSeconds() !== s) {
    return ''
  }
  const local = calendar.getTime()
  const offsets = new Set<number>()
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    const wall = wallClock(local + delta, timeZone)
    if (wall)
      offsets.add(Date.parse(`${wall}Z`) - (local + delta))
  }
  let earliest: number | undefined
  for (const offset of offsets) {
    const target = local - offset
    const shown = value.slice(0, 19)
    if (wallClock(target, timeZone) === (shown.length === 16 ? `${shown}:00` : shown)) {
      if (earliest === undefined || target < earliest)
        earliest = target
    }
  }
  return earliest === undefined ? '' : new Date(earliest + Number((match[7] ?? '').padEnd(3, '0'))).toISOString()
}
