import type { DeliveryRecord, HistoryPage, HistoryQuery, HistoryRecord, OccurrenceJournal, OperationResult, PendingDelivery, SchedulerRun, SchedulerTask } from '../types'
import { defineService } from 'dsh-tauri'
import { runtime, withWriteQueue } from '../config/runtime'
import { storage } from '../storage'

const HISTORY_KEY = 'history'
const HISTORY_DAYS = 30
const HISTORY_RECORDS = 200
const DAY_MS = 86_400_000
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'skipped', 'cancelled'])
const SCHEDULER_INTERRUPTED_ERROR = 'host_interrupted'

interface RetentionFlags {
  earlierRecordsUnavailable: boolean
  earlierRecordsPruned: boolean
}

interface HistoryState {
  version: 2
  records: HistoryRecord[]
  flags: Record<string, RetentionFlags>
  pending: PendingDelivery[]
  journal: OccurrenceJournal[]
}

export const history = defineService({
  async query(query: HistoryQuery): Promise<OperationResult<HistoryPage>> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
      return { ok: false, error: 'limit 必须是 1 到 100 的整数', code: 'history_invalid_limit' }
    if ((query.taskId !== undefined && (typeof query.taskId !== 'string' || query.taskId.length === 0))
      || (query.before !== undefined && (typeof query.before !== 'string' || query.before.length === 0))) {
      return { ok: false, error: '历史查询参数无效', code: 'history_invalid_query' }
    }
    return withWriteQueue(async () => {
      const state = await loadState()
      if (prune(state))
        await saveState(state)
      const all = order(state.records.filter(record => query.taskId === undefined || record.taskId === query.taskId))
      const beforeIndex = query.before === undefined ? -1 : all.findIndex(record => record.id === query.before)
      if (query.before !== undefined && beforeIndex === -1)
        return { ok: false, error: '历史游标不存在或已被清理', code: 'delivery_cursor_not_found' }
      const offset = beforeIndex + 1
      const records = all.slice(offset, offset + query.limit)
      const flags = query.taskId === undefined ? Object.values(state.flags) : [state.flags[query.taskId] ?? emptyFlags()]
      return {
        ok: true,
        records,
        runs: records.flatMap(record => record.delivery === 'new-session' ? [asRun(record)] : []),
        ...(offset + records.length < all.length ? { nextBefore: records.at(-1)!.id } : {}),
        earlierRecordsUnavailable: flags.some(item => item.earlierRecordsUnavailable),
        earlierRecordsPruned: flags.some(item => item.earlierRecordsPruned),
        retention: { days: HISTORY_DAYS, records: HISTORY_RECORDS },
      }
    })
  },

  async listRuns(taskId?: string): Promise<SchedulerRun[]> {
    return withWriteQueue(async () => {
      const state = await loadState()
      if (prune(state))
        await saveState(state)
      return order(state.records).flatMap(record => record.delivery === 'new-session' && (taskId === undefined || record.taskId === taskId) ? [asRun(record)] : [])
    })
  },

  async saveRun(run: SchedulerRun, expected?: SchedulerTask): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      const record: HistoryRecord = { ...run, delivery: 'new-session', occurrence: run.scheduledFor }
      upsert(state, record)
      if (expected && !state.journal.some(item => item.id === run.id))
        state.journal.push({ id: run.id, task: structuredClone(expected), trigger: run.trigger, scheduledAt: run.scheduledFor })
      const journal = state.journal.find(item => item.id === run.id)
      if (journal) {
        journal.run = run
        journal.completedAt = run.status === 'queued' || run.status === 'running' ? undefined : run.finishedAt ?? run.startedAt
      }
      prune(state)
      await saveState(state)
    })
  },

  async recoverRuns(): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      const stored = state.records.flatMap(record => record.delivery === 'new-session' ? [asRun(record)] : [])
      const journalRuns = state.journal.flatMap(item => item.run ? [item.run] : [])
      let changed = false
      for (const run of new Map([...stored, ...journalRuns].map(item => [item.id, item])).values()) {
        if (run.status !== 'running' || runtime.running.has(run.taskId))
          continue
        const interrupted: SchedulerRun = { ...run, status: 'interrupted', finishedAt: new Date().toISOString(), error: run.error || SCHEDULER_INTERRUPTED_ERROR }
        upsert(state, { ...interrupted, delivery: 'new-session', occurrence: interrupted.scheduledFor })
        const journal = state.journal.find(item => item.id === run.id)
        if (journal) {
          journal.run = interrupted
          journal.completedAt = interrupted.finishedAt
        }
        changed = true
      }
      if (changed) {
        prune(state)
        await saveState(state)
      }
    })
  },

  async journals(taskId?: string): Promise<OccurrenceJournal[]> {
    return withWriteQueue(async () => (await loadState()).journal.filter(item => taskId === undefined || item.task.id === taskId))
  },

  async acknowledge(id: string): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      state.journal = state.journal.filter(item => item.id !== id)
      await saveState(state)
    })
  },

  async remove(id: string): Promise<boolean> {
    return withWriteQueue(async () => {
      const state = await loadState()
      const found = state.records.find(record => record.id === id)
      if (!found)
        return false
      state.records = state.records.filter(record => record.id !== id)
      flagsFor(state, found.taskId).earlierRecordsPruned = true
      prune(state)
      await saveState(state)
      return true
    })
  },

  async pending(taskId?: string): Promise<PendingDelivery[]> {
    return withWriteQueue(async () => {
      const state = await loadState()
      return state.pending.filter(item => taskId === undefined || item.task.id === taskId)
    })
  },

  async prepare(pending: PendingDelivery): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      if (state.pending.some(item => item.task.id === pending.task.id))
        return
      state.pending.push(pending)
      await saveState(state)
    })
  },

  async commit(pending: PendingDelivery): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      const record: DeliveryRecord = {
        id: pending.message.id,
        taskId: pending.task.id,
        taskName: pending.task.name,
        delivery: 'this-session',
        occurrence: pending.scheduledAt,
        trigger: pending.trigger,
        sessionId: pending.task.sessionId!,
        scheduledAt: pending.scheduledAt,
        deliveredAt: pending.deliveredAt,
        messageId: pending.message.id,
        prompt: pending.task.prompt,
      }
      upsert(state, record)
      if (!state.journal.some(item => item.id === record.id))
        state.journal.push({ id: record.id, task: pending.task, trigger: pending.trigger, scheduledAt: pending.scheduledAt, completedAt: pending.deliveredAt })
      state.pending = state.pending.filter(item => item.task.id !== pending.task.id)
      prune(state)
      await saveState(state)
    })
  },

  async discardPending(taskId: string): Promise<void> {
    await withWriteQueue(async () => {
      const state = await loadState()
      state.pending = state.pending.filter(item => item.task.id !== taskId)
      await saveState(state)
    })
  },

  async latestDelivered(taskId: string): Promise<DeliveryRecord | undefined> {
    return withWriteQueue(async () => {
      const state = await loadState()
      return order(state.records).find((record): record is DeliveryRecord => record.delivery === 'this-session' && record.taskId === taskId && record.trigger === 'schedule')
    })
  },
})

async function loadState(): Promise<HistoryState> {
  const saved = await storage.getItem<HistoryState>(HISTORY_KEY)
  if (saved !== null && saved !== undefined) {
    if (saved.version !== 2 || !Array.isArray(saved.records) || !saved.records.every(isRecord)
      || !Array.isArray(saved.pending) || !saved.pending.every(isPending) || !saved.flags || typeof saved.flags !== 'object'
      || (saved.journal !== undefined && (!Array.isArray(saved.journal) || !saved.journal.every(isJournal)))) {
      throw new Error('SCHEDULER_HISTORY_INVALID: refusing to overwrite malformed history')
    }
    return { ...saved, journal: saved.journal ?? [] }
  }
  const legacy = await storage.getItem<{ runs?: unknown[] }>('runs')
  const records = (Array.isArray(legacy?.runs) ? legacy.runs : []).flatMap((run) => {
    if (!isRun(run))
      return []
    return [{ ...run, delivery: 'new-session' as const, occurrence: run.scheduledFor }]
  })
  const state: HistoryState = {
    version: 2,
    records,
    pending: [],
    journal: [],
    flags: Object.fromEntries(records.map(record => [record.taskId, { earlierRecordsUnavailable: true, earlierRecordsPruned: false }])),
  }
  if (legacy !== null && legacy !== undefined) {
    prune(state)
    await saveState(state)
  }
  return state
}

async function saveState(state: HistoryState): Promise<void> {
  await storage.setItem(HISTORY_KEY, `${JSON.stringify(state, null, 2)}\n`)
}

function upsert(state: HistoryState, record: HistoryRecord): void {
  const at = state.records.findIndex(item => item.id === record.id)
  if (at === -1)
    state.records.push(record)
  else
    state.records[at] = record
  flagsFor(state, record.taskId)
}

function prune(state: HistoryState): boolean {
  const floor = Date.now() - HISTORY_DAYS * DAY_MS
  const counts = new Map<string, number>()
  const before = state.records.length
  state.records = order(state.records).filter((record) => {
    const retainedAt = record.delivery === 'this-session' ? record.deliveredAt : record.finishedAt ?? record.startedAt
    const count = counts.get(record.taskId) ?? 0
    if (Date.parse(retainedAt) < floor || count >= HISTORY_RECORDS) {
      flagsFor(state, record.taskId).earlierRecordsPruned = true
      return false
    }
    counts.set(record.taskId, count + 1)
    return true
  })
  return before !== state.records.length
}

function order(records: HistoryRecord[]): HistoryRecord[] {
  return [...records].sort((left, right) => Date.parse(right.occurrence) - Date.parse(left.occurrence) || right.id.localeCompare(left.id, 'en'))
}

function flagsFor(state: HistoryState, taskId: string): RetentionFlags {
  return state.flags[taskId] ??= emptyFlags()
}

function emptyFlags(): RetentionFlags {
  return { earlierRecordsUnavailable: false, earlierRecordsPruned: false }
}

function asRun(record: Extract<HistoryRecord, { delivery: 'new-session' }>): SchedulerRun {
  const { delivery: _delivery, occurrence: _occurrence, ...run } = record
  return run
}

function isRun(value: unknown): value is SchedulerRun {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const run = value as SchedulerRun
  return typeof run.id === 'string' && typeof run.taskId === 'string' && typeof run.taskName === 'string'
    && RUN_STATUSES.has(run.status) && (run.trigger === 'schedule' || run.trigger === 'manual')
    && validInstant(run.scheduledFor) && validInstant(run.startedAt)
    && (run.finishedAt === undefined || validInstant(run.finishedAt))
}

function isRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const record = value as HistoryRecord
  if (record.delivery === 'new-session')
    return isRun(record) && validInstant(record.occurrence)
  return record.delivery === 'this-session' && typeof record.id === 'string' && typeof record.taskId === 'string'
    && typeof record.taskName === 'string' && typeof record.prompt === 'string' && typeof record.sessionId === 'string'
    && typeof record.messageId === 'string' && record.id === record.messageId && validInstant(record.occurrence)
    && validInstant(record.scheduledAt) && validInstant(record.deliveredAt) && (record.trigger === 'schedule' || record.trigger === 'manual')
}

function isPending(value: unknown): value is PendingDelivery {
  if (!value || typeof value !== 'object')
    return false
  const pending = value as PendingDelivery
  return pending.task?.delivery === 'this-session' && typeof pending.task.id === 'string' && typeof pending.task.sessionId === 'string'
    && pending.message?.role === 'user' && typeof pending.message.id === 'string'
    && validInstant(pending.scheduledAt) && validInstant(pending.deliveredAt)
    && (pending.nextRunAt === undefined || validInstant(pending.nextRunAt))
    && (pending.trigger === 'schedule' || pending.trigger === 'manual')
}

function isJournal(value: unknown): value is OccurrenceJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const journal = value as OccurrenceJournal
  return typeof journal.id === 'string' && typeof journal.task?.id === 'string'
    && (journal.task.delivery === 'this-session' || journal.task.delivery === 'new-session')
    && validInstant(journal.scheduledAt) && (journal.trigger === 'schedule' || journal.trigger === 'manual')
    && (journal.completedAt === undefined || validInstant(journal.completedAt))
    && (journal.run === undefined || (isRun(journal.run) && journal.run.id === journal.id && journal.run.taskId === journal.task.id))
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
