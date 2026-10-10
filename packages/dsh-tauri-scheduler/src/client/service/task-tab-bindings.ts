import type { ScheduleForm, TaskFormState } from '../types'
import type { TaskTabNavigation, TaskTabPage } from '../types/task-tab'
import { WEEKDAYS } from '../../shared/constants'

interface StoredEntry {
  kind: string
  contentId: string
  id: string
  sessionId?: string
}

const PREFIX = 'dsh.schedule.task-tab.v1.'

function entriesOf(raw: string | null): Map<string, StoredEntry> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return new Map()
    return new Map(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object')
        return []
      const entry = value as Record<string, unknown>
      if (typeof entry.kind !== 'string' || typeof entry.contentId !== 'string' || typeof entry.id !== 'string' || !entry.id.trim())
        return []
      if (entry.sessionId !== undefined && (typeof entry.sessionId !== 'string' || !entry.sessionId.trim()))
        return []
      return [[key, { kind: entry.kind, contentId: entry.contentId, id: entry.id, sessionId: entry.sessionId } as StoredEntry]]
    }))
  }
  catch {
    return new Map()
  }
}

export class TaskTabBindings {
  private readonly memory = new Map<string, Map<string, StoredEntry>>()

  constructor(private readonly liveTabIds?: (sessionId: string) => readonly string[] | undefined) {}

  read(sessionId: string, page: TaskTabPage): TaskTabNavigation | undefined {
    const entry = this.document(sessionId).get(page.id)
    return entry?.kind === page.kind && entry.contentId === page.contentId
      ? { id: entry.id, sessionId: entry.sessionId }
      : undefined
  }

  write(sessionId: string, page: TaskTabPage, target: TaskTabNavigation): void {
    if (target.draft)
      return
    const entries = new Map(this.document(sessionId))
    entries.set(page.id, { kind: page.kind, contentId: page.contentId, id: target.id, sessionId: target.sessionId })
    this.store(sessionId, entries)
  }

  forget(sessionId: string, page: TaskTabPage): void {
    const entries = new Map(this.document(sessionId))
    entries.delete(page.id)
    this.store(sessionId, entries)
  }

  dropMismatched(sessionId: string, page: TaskTabPage): void {
    const entry = this.document(sessionId).get(page.id)
    if (entry && (entry.kind !== page.kind || entry.contentId !== page.contentId))
      this.forget(sessionId, page)
  }

  clear(): void {
    this.memory.clear()
  }

  private document(sessionId: string): Map<string, StoredEntry> {
    const cached = this.memory.get(sessionId)
    if (cached)
      return cached
    try {
      const entries = entriesOf(typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFIX + sessionId))
      this.memory.set(sessionId, entries)
      return entries
    }
    catch {
      return new Map()
    }
  }

  private store(sessionId: string, entries: Map<string, StoredEntry>): void {
    const live = this.liveTabIds?.(sessionId)
    const kept = live?.length ? new Map([...entries].filter(([id]) => live.includes(id))) : entries
    this.memory.set(sessionId, kept)
    try {
      if (typeof localStorage === 'undefined')
        return
      if (kept.size)
        localStorage.setItem(PREFIX + sessionId, JSON.stringify(Object.fromEntries(kept)))
      else
        localStorage.removeItem(PREFIX + sessionId)
    }
    catch (error) {
      console.error('Task tab binding persistence failed:', error)
    }
  }
}

function isScheduleForm(value: unknown): value is ScheduleForm {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const schedule = value as Record<string, unknown>
  if (schedule.timeZone !== undefined && typeof schedule.timeZone !== 'string')
    return false
  switch (schedule.kind) {
    case 'once': return typeof schedule.at === 'string'
    case 'hourly': return typeof schedule.minute === 'number'
    case 'daily':
    case 'workdays': return typeof schedule.time === 'string'
    case 'interval': return typeof schedule.everyMinutes === 'number' && (schedule.anchor === undefined || typeof schedule.anchor === 'string')
    case 'weekly': return typeof schedule.time === 'string' && Array.isArray(schedule.weekdays)
      && schedule.weekdays.every(day => WEEKDAYS.includes(day))
    case 'monthly': return typeof schedule.day === 'number' && typeof schedule.time === 'string'
    case 'custom': return typeof schedule.everyDays === 'number' && typeof schedule.time === 'string' && (schedule.anchor === undefined || typeof schedule.anchor === 'string')
    default: return false
  }
}

export function taskTabParams(value: unknown): TaskTabNavigation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const params = value as Record<string, unknown>
  if (params.sessionId !== undefined && (typeof params.sessionId !== 'string' || !params.sessionId.trim()))
    return undefined
  if (params.draft === true) {
    const initial = params.initial
    const valid = initial && typeof initial === 'object' && !Array.isArray(initial)
      && ['name', 'prompt', 'sessionId', 'workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'].every(key => typeof (initial as Record<string, unknown>)[key] === 'string')
      && 'delivery' in initial && (initial.delivery === 'this-session' || initial.delivery === 'new-session')
      && 'enabled' in initial && typeof initial.enabled === 'boolean'
      && (!('recommendationId' in initial) || initial.recommendationId === undefined || typeof initial.recommendationId === 'string')
      && 'schedule' in initial && isScheduleForm(initial.schedule)
    return { draft: true, sessionId: params.sessionId, initial: valid ? initial as TaskFormState : undefined }
  }
  if (params.draft !== undefined && params.draft !== false)
    return undefined
  return typeof params.id === 'string' && params.id.trim() ? { id: params.id, sessionId: params.sessionId } : undefined
}
