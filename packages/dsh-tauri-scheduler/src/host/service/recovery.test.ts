import type { SchedulerRun } from '../types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetWriteQueue, runtime } from '../config/runtime'
import { storage } from '../storage'
import { history } from './history'
import { recovery } from './recovery'
import { runs } from './runs'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const state = new Map<string, unknown>()
const now = '2026-06-01T12:00:00.000Z'

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

it('interrupts only unclaimed running records, preserves errors and leaves live records untouched', async () => {
  const records: SchedulerRun[] = ['running', 'failed', 'queued', 'running', 'running'].map((status, index) => ({ id: String(index), taskId: `task-${index}`, taskName: 'job', scheduledFor: now, startedAt: now, trigger: 'schedule', status: status as SchedulerRun['status'], ...(index === 3 ? { error: 'existing' } : {}) }))
  for (const run of records)
    await runs.save(run)
  runtime.running.add('task-4')
  await recovery.recover()
  expect(await runs.load('0')).toEqual({ ...records[0], status: 'interrupted', error: 'host_interrupted', finishedAt: now })
  expect(await runs.load('1')).toEqual(records[1])
  expect(await runs.load('2')).toEqual(records[2])
  expect(await runs.load('3')).toEqual({ ...records[3], status: 'interrupted', finishedAt: now })
  expect(await runs.load('4')).toEqual(records[4])
  expect(records[0]!.status).toBe('running')
  vi.mocked(storage.setItem).mockClear()
  await recovery.recover()
  expect(storage.setItem).not.toHaveBeenCalled()
})

it('serializes recovery with completion so a stale running snapshot cannot overwrite success', async () => {
  const running: SchedulerRun = { id: 'race', taskId: 'race-task', taskName: 'job', scheduledFor: now, startedAt: now, trigger: 'manual', status: 'running' }
  await runs.save(running)
  const completed = { ...running, status: 'succeeded' as const, finishedAt: now }
  await Promise.all([history.saveRun(completed), recovery.recover()])
  expect(await runs.load(running.id)).toEqual(completed)
})
