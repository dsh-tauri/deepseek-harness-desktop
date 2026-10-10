import type { PendingDelivery, TaskInput } from '../types'
import type { SessionInspection } from './delivery.deadline.test.harness'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue, runtime } from '../config/runtime'
import { deferred, DUE, installHost, NOW, observe, releaseOperations, resetStorage, seed, target, unrelated } from './delivery.deadline.test.harness'
import { history } from './history'
import { scheduler } from './scheduler'
import { task } from './task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const SESSION_TIMEOUT = { ok: false, error: '等待宿主会话操作超时', code: 'session_unavailable' } as const
const DELIVERY_PENDING = { ok: false, error: 'Session persistence did not acknowledge the reminder', code: 'delivery_pending' } as const
let host: ReturnType<typeof installHost>

beforeEach(() => {
  vi.resetAllMocks()
  resetWriteQueue()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  resetStorage()
  seed(target, unrelated)
  host = installHost()
})

afterEach(async () => {
  await releaseOperations()
  await scheduler.stop()
  host.dispose()
  resetWriteQueue()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function expectNoReceipt(): Promise<void> {
  expect(await history.query({ taskId: target.id, limit: 20 })).toEqual({
    ok: true,
    records: [],
    runs: [],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
    retention: { days: 30, records: 200 },
  })
}

async function expectRetainedPending(scheduledAt: string, trigger: 'schedule' | 'manual'): Promise<PendingDelivery> {
  const pending = await history.pending(target.id)
  expect(pending).toHaveLength(1)
  const item = pending[0]!
  expect(item).toEqual({ task: target, trigger, scheduledAt, deliveredAt: NOW, message: host.followup.mock.calls[0]![0] })
  expect(runtime.pending.get(target.id)).toEqual(item)
  expect(await task.get(target.id)).toEqual(target)
  await expectNoReceipt()
  return item
}

async function expectTimedOut(observation: ReturnType<typeof observe>): Promise<void> {
  await vi.advanceTimersByTimeAsync(9999)
  expect(observation.settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(observation.settled, 'the real task-queue operation must settle at 10,000 ms rather than waiting for the platform forever').toHaveBeenCalledTimes(1)
  expect(runtime.accepted.size).toBe(0)
}

describe('bounded this-session platform operations', () => {
  it('commits a normal acknowledged reminder with no deadline timer or execution success claim', async () => {
    await scheduler.tick()
    expect(host.resolveAgent).toHaveBeenCalledExactlyOnceWith('deadline-session')
    expect(host.flush).toHaveBeenCalledExactlyOnceWith(host.session)
    expect(host.followup).toHaveBeenCalledTimes(1)
    const message = host.followup.mock.calls[0]![0]
    expect(message.role).toBe('user')
    expect(message.id).toBeTypeOf('string')
    expect(message.source).toEqual({ kind: 'schedule', form: 'notice', summary: 'Scheduled: deadline reminder' })
    expect(await history.query({ taskId: target.id, limit: 20 })).toEqual({
      ok: true,
      records: [{ id: message.id, messageId: message.id, taskId: 'deadline-task', taskName: 'deadline reminder', delivery: 'this-session', occurrence: DUE, trigger: 'schedule', sessionId: 'deadline-session', scheduledAt: DUE, deliveredAt: NOW, prompt: 'preserve the original reminder' }],
      runs: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    const { nextRunAt: _nextRunAt, ...completed } = target
    expect(await task.get(target.id)).toEqual({ ...completed, status: 'inactive', lastRunAt: NOW, updatedAt: NOW })
    expect(await history.pending()).toEqual([])
    expect(await history.journals()).toEqual([])
    expect(runtime.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.create).not.toHaveBeenCalled()
    expect(host.agent.whenIdle).not.toHaveBeenCalled()
    expect(host.agent.steer).not.toHaveBeenCalled()
    expect(host.agent.inject).not.toHaveBeenCalled()
  })

  it('preserves false-flush failure and retries the admitted message identity without another followup', async () => {
    host.flush.mockResolvedValueOnce(false)
    expect(await scheduler.trigger(target.id)).toEqual(DELIVERY_PENDING)
    const pending = await expectRetainedPending(NOW, 'manual')
    expect(runtime.failed.has(target.id)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(2)
    expect(await history.query({ taskId: target.id, limit: 20 })).toMatchObject({ ok: true, records: [{ id: pending.message.id, messageId: pending.message.id, trigger: 'manual', scheduledAt: NOW }] })
    expect(await task.get(target.id)).toEqual({ ...target, lastRunAt: NOW, updatedAt: NOW })
    expect(await history.pending()).toEqual([])
  })

  it('preserves rejected-flush failure without a receipt and accepts the same identity on explicit retry', async () => {
    host.flush.mockRejectedValueOnce(new Error('isolated platform persistence failure'))
    expect(await scheduler.trigger(target.id)).toEqual({ ok: false, error: 'isolated platform persistence failure', code: 'delivery_failed' })
    const pending = await expectRetainedPending(NOW, 'manual')
    expect(runtime.failed.has(target.id)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: target.id, limit: 20 })).toMatchObject({ ok: true, records: [{ messageId: pending.message.id }] })
    expect(runtime.failed.has(target.id)).toBe(false)
  })

  it('fails a hung resolve at 10 seconds, releases the queue, and never follows up a late restored Agent', async () => {
    const resolving = deferred({ agent: host.agent })
    host.resolveAgent.mockReturnValueOnce(resolving.promise)
    const run = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.resolveAgent).toHaveBeenCalledExactlyOnceWith('deadline-session')
    const removal = observe(task.remove(unrelated.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(removal.settled).not.toHaveBeenCalled()
    await expectTimedOut(run)
    expect(await run.promise).toEqual(SESSION_TIMEOUT)
    expect(removal.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await removal.promise).toEqual({ ok: true })
    expect(await task.get(target.id)).toEqual(target)
    expect(await history.pending()).toEqual([])
    await expectNoReceipt()
    resolving.resolve({ agent: host.agent })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.resolveAgent).toHaveBeenCalledTimes(1)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).not.toHaveBeenCalled()
    expect(await task.get(target.id)).toEqual(target)
    await expectNoReceipt()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['initial binding', 'post-restoration recheck'] as const)('fails a hung %s inspect without admission or blocking a later task mutation', async (phase) => {
    const inspection = deferred<SessionInspection>({ meta: { id: 'deadline-session' }, events: [] })
    if (phase === 'post-restoration recheck')
      host.inspect.mockResolvedValueOnce({ meta: { id: 'deadline-session' }, events: [] })
    host.inspect.mockReturnValueOnce(inspection.promise)
    const run = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspect).toHaveBeenCalledTimes(phase === 'initial binding' ? 1 : 2)
    expect(host.resolveAgent).toHaveBeenCalledTimes(phase === 'initial binding' ? 0 : 1)
    const removal = observe(task.remove(unrelated.id))
    await expectTimedOut(run)
    expect(await run.promise).toEqual(SESSION_TIMEOUT)
    expect(removal.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await removal.promise).toEqual({ ok: true })
    expect(await task.get(target.id)).toEqual(target)
    expect(await history.pending()).toEqual([])
    await expectNoReceipt()
    inspection.resolve({ meta: { id: 'deadline-session' }, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).not.toHaveBeenCalled()
    expect(await task.get(target.id)).toEqual(target)
    await expectNoReceipt()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cold pending inspection while preserving the prepared identity and ignoring late evidence', async () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'already admitted reminder' }], source: { kind: 'schedule', form: 'notice', summary: 'durable pending reminder' } })
    const pending: PendingDelivery = { task: target, trigger: 'schedule', scheduledAt: DUE, deliveredAt: NOW, message }
    await history.prepare(pending)
    host.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    const inspection = deferred<SessionInspection>({ meta: { id: 'deadline-session' }, events: structuredClone(host.events) })
    host.inspect.mockReturnValueOnce(inspection.promise)
    const run = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspect).toHaveBeenCalledExactlyOnceWith('deadline-session')
    const removal = observe(task.remove(unrelated.id))
    await expectTimedOut(run)
    expect(await run.promise).toEqual(SESSION_TIMEOUT)
    expect(removal.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await removal.promise).toEqual({ ok: true })
    expect(await history.pending(target.id)).toEqual([pending])
    expect(await task.get(target.id)).toEqual(target)
    await expectNoReceipt()
    inspection.resolve({ meta: { id: 'deadline-session' }, events: structuredClone(host.events) })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.resolveAgent).not.toHaveBeenCalled()
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).not.toHaveBeenCalled()
    expect(await history.pending(target.id)).toEqual([pending])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns pending at 10 seconds for a hung flush and frees a later mutation without fabricating durability', async () => {
    const flushing = deferred(true)
    host.flush.mockReturnValueOnce(flushing.promise)
    const run = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.flush).toHaveBeenCalledExactlyOnceWith(host.session)
    expect(host.followup).toHaveBeenCalledTimes(1)
    const removal = observe(task.remove(unrelated.id))
    await expectTimedOut(run)
    expect(await run.promise).toEqual(DELIVERY_PENDING)
    expect(removal.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await removal.promise).toEqual({ ok: true })
    await expectRetainedPending(NOW, 'manual')
    expect(runtime.failed.has(target.id)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds successive drives of one hung flush without accumulating platform calls or duplicate message identities', async () => {
    const flushing = deferred(true)
    host.flush.mockReturnValueOnce(flushing.promise)
    const first = observe(scheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    await expectTimedOut(first)
    await first.promise
    const pending = await expectRetainedPending(DUE, 'schedule')
    const retry = observe(scheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(1)
    await expectTimedOut(retry)
    await retry.promise
    expect(await history.pending(target.id)).toEqual([pending])
    expect(runtime.pending.get(target.id)?.message.id).toBe(pending.message.id)
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(await task.get(target.id)).toEqual(target)
    await expectNoReceipt()
  })

  it('accepts a late true flush only on the next explicit drive while retaining the original occurrence and message identity', async () => {
    const flushing = deferred(true)
    host.flush.mockReturnValueOnce(flushing.promise)
    const first = observe(scheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    await expectTimedOut(first)
    await first.promise
    const pending = await expectRetainedPending(DUE, 'schedule')
    flushing.resolve(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await history.pending(target.id)).toEqual([pending])
    expect(await task.get(target.id)).toEqual(target)
    await expectNoReceipt()
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: target.id, limit: 20 })).toEqual({
      ok: true,
      records: [{ id: pending.message.id, messageId: pending.message.id, taskId: 'deadline-task', taskName: 'deadline reminder', delivery: 'this-session', occurrence: DUE, trigger: 'schedule', sessionId: 'deadline-session', scheduledAt: DUE, deliveredAt: '2026-06-01T12:15:11.000Z', prompt: 'preserve the original reminder' }],
      runs: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 200 },
    })
    const { nextRunAt: _nextRunAt, ...completed } = target
    expect(await task.get(target.id)).toEqual({ ...completed, status: 'inactive', lastRunAt: '2026-06-01T12:15:11.000Z', updatedAt: '2026-06-01T12:15:11.000Z' })
    expect(await history.pending()).toEqual([])
    expect(await history.journals()).toEqual([])
    expect(runtime.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a late false flush unacknowledged and retries durability without re-following up the admitted reminder', async () => {
    const flushing = deferred(false)
    host.flush.mockReturnValueOnce(flushing.promise)
    const first = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    await expectTimedOut(first)
    expect(await first.promise).toEqual(DELIVERY_PENDING)
    const pending = await expectRetainedPending(NOW, 'manual')
    flushing.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(await history.pending(target.id)).toEqual([pending])
    await expectNoReceipt()
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(2)
    expect(await history.query({ taskId: target.id, limit: 20 })).toMatchObject({ ok: true, records: [{ messageId: pending.message.id, scheduledAt: NOW, trigger: 'manual' }] })
  })

  it('preserves a late flush rejection without detached side effects and retries the same admitted identity', async () => {
    const flushing = deferred(true)
    host.flush.mockReturnValueOnce(flushing.promise)
    const first = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    await expectTimedOut(first)
    expect(await first.promise).toEqual(DELIVERY_PENDING)
    const pending = await expectRetainedPending(NOW, 'manual')
    flushing.reject(new Error('late platform persistence rejection'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await history.pending(target.id)).toEqual([pending])
    expect(await task.get(target.id)).toEqual(target)
    expect(runtime.failed.has(target.id)).toBe(false)
    expect(host.flush).toHaveBeenCalledTimes(1)
    await expectNoReceipt()
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(2)
    expect(await history.query({ taskId: target.id, limit: 20 })).toMatchObject({ ok: true, records: [{ id: pending.message.id, messageId: pending.message.id, trigger: 'manual', scheduledAt: NOW }] })
    expect(await history.pending()).toEqual([])
    expect(await history.journals()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets scheduler shutdown drain a hung durability barrier at its deadline while preserving recovery evidence', async () => {
    const flushing = deferred(true)
    host.flush.mockReturnValueOnce(flushing.promise)
    const first = observe(scheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    const stopped = observe(scheduler.stop())
    await vi.advanceTimersByTimeAsync(9999)
    expect(stopped.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(first.settled).toHaveBeenCalledTimes(1)
    expect(stopped.settled).toHaveBeenCalledTimes(1)
    await first.promise
    await stopped.promise
    const pending = await expectRetainedPending(DUE, 'schedule')
    flushing.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(await history.pending(target.id)).toEqual([pending])
    await expectNoReceipt()
    expect(runtime.accepted.size).toBe(0)
    expect(await scheduler.trigger(target.id)).toEqual({ ok: false, error: '调度器正在卸载', code: 'scheduler_stopping' })
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['inspect', 'resolveAgent', 'flush'] as const)('accepts a successful %s settled at 9,999 ms and cancels the unused deadline', async (operation) => {
    const inspection = deferred<SessionInspection>({ meta: { id: 'deadline-session' }, events: [] })
    const resolving = deferred({ agent: host.agent })
    const flushing = deferred(true)
    if (operation === 'inspect')
      host.inspect.mockReturnValueOnce(inspection.promise)
    if (operation === 'resolveAgent')
      host.resolveAgent.mockReturnValueOnce(resolving.promise)
    if (operation === 'flush')
      host.flush.mockReturnValueOnce(flushing.promise)
    const run = observe(scheduler.trigger(target.id))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9999)
    expect(run.settled).not.toHaveBeenCalled()
    inspection.resolve({ meta: { id: 'deadline-session' }, events: [] })
    resolving.resolve({ agent: host.agent })
    flushing.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await run.promise).toEqual({ ok: true })
    expect(host.resolveAgent).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.pending()).toEqual([])
    expect(await task.get(target.id)).toEqual({ ...target, lastRunAt: '2026-06-01T12:15:09.999Z', updatedAt: '2026-06-01T12:15:09.999Z' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(run.settled).toHaveBeenCalledTimes(1)
  })
})

describe('bounded cold inspection in real task mutations', () => {
  it.each(['create', 'update'] as const)('fails a hung %s binding inspection without holding either queue or applying a late validation', async (operation) => {
    const sessionId = operation === 'create' ? 'deadline-session' : 'rebinding-session'
    const inspection = deferred<SessionInspection>({ meta: { id: sessionId }, events: [] })
    host.inspect.mockReturnValueOnce(inspection.promise)
    const input: TaskInput = { delivery: 'this-session', sessionId, name: 'new bound reminder', prompt: 'never commit a timed-out validation', schedule: { kind: 'once', at: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' }, enabled: false }
    const mutation = observe(operation === 'create' ? task.create(input) : task.update(target.id, { sessionId, prompt: 'never commit a timed-out edit' }, target))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspect).toHaveBeenCalledExactlyOnceWith(sessionId)
    const removal = observe(task.remove(unrelated.id))
    await vi.advanceTimersByTimeAsync(9999)
    expect(mutation.settled).not.toHaveBeenCalled()
    expect(removal.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mutation.settled, 'a hung cold binding read must not hold the task or storage write queue forever').toHaveBeenCalledExactlyOnceWith(SESSION_TIMEOUT)
    expect(await mutation.promise).toEqual(SESSION_TIMEOUT)
    expect(removal.settled).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(await removal.promise).toEqual({ ok: true })
    expect(await task.list()).toEqual([target])
    inspection.resolve({ meta: { id: sessionId }, events: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(await task.list()).toEqual([target])
    expect(host.resolveAgent).not.toHaveBeenCalled()
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).not.toHaveBeenCalled()
    await expectNoReceipt()
    expect(vi.getTimerCount()).toBe(0)
  })
})
