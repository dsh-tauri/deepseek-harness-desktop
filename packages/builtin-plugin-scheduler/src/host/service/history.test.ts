import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { HistoryRecord, PendingDelivery, SchedulerRun, SchedulerTask } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue } from '../config/runtime'
import { storage } from '../storage'
import { history } from './history'
import { recovery } from './recovery'
import { runs } from './runs'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const state = new Map<string, unknown>()
const now = '2026-06-01T12:00:00.000Z'
const taskFixture: SchedulerTask = {
  id: 'task-1',
  delivery: 'this-session',
  status: 'active',
  sessionId: 'session-1',
  name: 'reminder',
  prompt: 'original prompt',
  schedule: { kind: 'daily', time: '12:00', timeZone: 'UTC' },
  enabled: true,
  createdAt: now,
  updatedAt: now,
  nextRunAt: now,
}

function run(id: string, occurrence = now, taskId = 'task-1'): SchedulerRun {
  return { id, taskId, taskName: 'job', prompt: 'run prompt', trigger: 'schedule', status: 'succeeded', scheduledFor: occurrence, startedAt: now, finishedAt: now, sessionId: 'run-session' }
}

function pending(id: string, scheduledAt = now, taskId = 'task-1'): PendingDelivery {
  return {
    task: { ...taskFixture, id: taskId },
    trigger: 'schedule',
    scheduledAt,
    deliveredAt: now,
    nextRunAt: '2026-06-02T12:00:00.000Z',
    message: { id: id as MessageId, role: 'user', content: [{ type: 'text', text: 'framed reminder' }], source: { kind: 'schedule' } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetWriteQueue()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  state.clear()
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
  })
})

afterEach(() => {
  resetWriteQueue()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mixed occurrence history', () => {
  it.each([undefined, 0, 101, 1.5, Number.NaN, '10'])('requires an integer limit in 1..100: %j', async (limit) => {
    expect(await history.query({ limit } as never)).toMatchObject({ ok: false, code: 'history_invalid_limit' })
    expect(storage.getItem).not.toHaveBeenCalled()
  })

  it('sorts by occurrence rather than start/delivery and pages by stable identity ties', async () => {
    await history.saveRun(run('run-z', '2026-06-01T10:00:00.000Z'))
    await history.commit(pending('message-b', '2026-06-01T11:00:00.000Z'))
    await history.saveRun(run('run-a', '2026-06-01T11:00:00.000Z'))
    await history.commit(pending('message-a', '2026-06-01T11:00:00.000Z'))
    const first = await history.query({ taskId: 'task-1', limit: 2 })
    expect(first).toMatchObject({ ok: true, records: [{ id: 'run-a' }, { id: 'message-b' }], nextBefore: 'message-b', retention: { days: 30, records: 200 } })
    const second = await history.query({ taskId: 'task-1', limit: 2, before: 'message-b' })
    expect(second).toMatchObject({ ok: true, records: [{ id: 'message-a' }, { id: 'run-z' }] })
    expect(second).not.toHaveProperty('nextBefore')
    if (!first.ok)
      throw new Error(first.error)
    expect(first.runs).toEqual([run('run-a', '2026-06-01T11:00:00.000Z')])
  })

  it('rejects a missing or cross-task cursor instead of silently restarting the page', async () => {
    await history.saveRun(run('run-1'))
    await history.commit(pending('message-2', now, 'task-2'))
    expect(await history.query({ taskId: 'task-1', limit: 10, before: 'message-2' })).toMatchObject({ ok: false, code: 'delivery_cursor_not_found' })
    expect(await history.query({ taskId: 'task-1', limit: 10, before: 'missing' })).toMatchObject({ ok: false, code: 'delivery_cursor_not_found' })
  })

  it('retains actual legacy runs with unavailable metadata and no fabricated delivery', async () => {
    state.set('runs', { version: 1, runs: [run('legacy')] })
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [{ delivery: 'new-session', id: 'legacy', occurrence: now }], earlierRecordsUnavailable: true, earlierRecordsPruned: false })
    expect(state.has('history')).toBe(true)
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, earlierRecordsUnavailable: true })
    await history.commit(pending('new-message'))
    const page = await history.query({ taskId: 'task-1', limit: 10 })
    expect(page).toMatchObject({ ok: true, records: expect.arrayContaining([{ ...run('legacy'), delivery: 'new-session', occurrence: now }]), earlierRecordsUnavailable: true })
  })

  it('keeps message identity and immutable sent content in committed receipts', async () => {
    const delivery = pending('message-1')
    await history.prepare(delivery)
    expect(await history.pending('task-1')).toEqual([delivery])
    await history.commit(delivery)
    delivery.task.prompt = 'edited later'
    expect(await history.pending()).toEqual([])
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [{ id: 'message-1', messageId: 'message-1', prompt: 'original prompt', scheduledAt: now, deliveredAt: now }] })
    expect(await history.latestDelivered('task-1')).toMatchObject({ messageId: 'message-1' })
  })

  it('combines both deliveries under a per-task 200-record cap, not a global cap', async () => {
    for (let i = 0; i < 210; i++) {
      const at = new Date(Date.parse(now) - i * 60_000).toISOString()
      if (i % 2)
        await history.commit(pending(`message-${String(i).padStart(3, '0')}`, at))
      else
        await history.saveRun(run(`run-${String(i).padStart(3, '0')}`, at))
    }
    await history.saveRun(run('other-task', now, 'task-2'))
    const first = await history.query({ taskId: 'task-1', limit: 100 })
    expect(first).toMatchObject({ ok: true, earlierRecordsPruned: true })
    if (!first.ok || !first.nextBefore)
      throw new Error('missing first page')
    const second = await history.query({ taskId: 'task-1', limit: 100, before: first.nextBefore })
    if (!second.ok)
      throw new Error(second.error)
    expect(first.records).toHaveLength(100)
    expect(second.records).toHaveLength(100)
    expect(first.records[0]!.id).toBe('run-000')
    expect(second.records.at(-1)!.id).toBe('message-199')
    expect(second).not.toHaveProperty('nextBefore')
    expect(await history.query({ taskId: 'task-2', limit: 100 })).toMatchObject({ ok: true, records: [{ id: 'other-task' }], earlierRecordsPruned: false })
    const saved = state.get('history') as { records: HistoryRecord[] }
    expect(saved.records).toHaveLength(201)
  })

  it('prunes by actual receipt/run retention time and persists sticky flags on reads', async () => {
    const oldDelivery = pending('old-message', '2026-05-31T12:00:00.000Z')
    oldDelivery.deliveredAt = '2026-04-30T12:00:00.000Z'
    await history.commit(oldDelivery)
    await history.saveRun({ ...run('old-run'), startedAt: '2026-04-30T12:00:00.000Z', finishedAt: '2026-04-30T12:00:00.000Z' })
    await history.commit(pending('recent-but-late', '2025-01-01T12:00:00.000Z'))
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [{ id: 'recent-but-late' }], earlierRecordsPruned: true })
    vi.setSystemTime(new Date('2026-07-02T12:00:00.000Z'))
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [], earlierRecordsPruned: true })
    expect((state.get('history') as { records: HistoryRecord[] }).records).toEqual([])
  })

  it('recovers unfinished new-session runs without altering this-session receipts', async () => {
    await runs.save({ ...run('unfinished'), status: 'running', finishedAt: undefined })
    await history.commit(pending('receipt'))
    await recovery.recover()
    expect(await runs.load('unfinished')).toMatchObject({ status: 'interrupted', error: 'host_interrupted', finishedAt: now })
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: expect.arrayContaining([expect.objectContaining({ delivery: 'this-session', messageId: 'receipt' })]) })
  })

  it('explicit history deletion is shared by both deliveries and marks pruning', async () => {
    await history.commit(pending('receipt'))
    await runs.save(run('run'))
    expect(await history.remove('receipt')).toBe(true)
    expect(await runs.remove('run')).toBe(true)
    expect(await history.remove('absent')).toBe(false)
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [], earlierRecordsPruned: true })
  })

  it('keeps transaction journals outside history retention and explicit record deletion', async () => {
    const target: SchedulerTask = { ...taskFixture, delivery: 'new-session', sessionId: undefined }
    const running = { ...run('transaction'), status: 'running' as const, finishedAt: undefined }
    await runs.save(running, target)
    target.prompt = 'edited after initial save'
    await runs.save({ ...running, status: 'succeeded', finishedAt: now })
    expect(await history.journals('task-1')).toMatchObject([{ id: 'transaction', task: { prompt: 'original prompt' }, completedAt: now, run: { status: 'succeeded' } }])
    expect(await history.remove('transaction')).toBe(true)
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [] })
    expect(await runs.load('transaction')).toMatchObject({ status: 'succeeded' })
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'))
    expect(await history.journals()).toHaveLength(1)
    await history.acknowledge('transaction')
    expect(await history.journals()).toEqual([])
  })

  it('recovers a running journal whose public history entry was already pruned', async () => {
    const target: SchedulerTask = { ...taskFixture, delivery: 'new-session', sessionId: undefined }
    await runs.save({ ...run('lost-history'), status: 'running', finishedAt: undefined }, target)
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'))
    expect(await history.query({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true, records: [], earlierRecordsPruned: true })
    await recovery.recover()
    expect(await history.journals()).toMatchObject([{ id: 'lost-history', completedAt: '2026-08-01T12:00:00.000Z', run: { status: 'interrupted', error: 'host_interrupted' } }])
  })

  it('accepts pre-journal version two storage without inventing transaction evidence', async () => {
    state.set('history', { version: 2, records: [], pending: [], flags: {} })
    expect(await history.journals()).toEqual([])
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('refuses to overwrite malformed persisted history', async () => {
    state.set('history', { version: 2, records: [{ delivery: 'this-session' }], flags: {}, pending: [] })
    await expect(history.saveRun(run('new'))).rejects.toThrow('SCHEDULER_HISTORY_INVALID: refusing to overwrite malformed history')
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
