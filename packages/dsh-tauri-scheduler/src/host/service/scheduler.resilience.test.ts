import type { HostContext, OperationResult, SchedulerRun, SchedulerTask } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue, runtime } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { delivery } from './delivery'
import { executor } from './executor'
import { history } from './history'
import { runs } from './runs'
import { scheduler } from './scheduler'
import { task } from './task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))
vi.mock('./delivery', () => ({ delivery: { run: vi.fn() } }))
vi.mock('./executor', () => ({ executor: { run: vi.fn() } }))

const NOW = '2026-06-01T12:15:00.000Z'
const DUE = '2026-06-01T12:00:00.000Z'
const state = new Map<string, unknown>()
const releases: Array<() => void> = []
const stops: Array<() => Promise<void>> = []
const disposers: Array<() => void> = []
let host: ReturnType<typeof installHost>

function installHost() {
  const listeners = new Set<symbol>()
  const logger = { warn: vi.fn() }
  const context = {
    agents: {
      withoutInitiator: vi.fn((fn: () => Promise<unknown>) => fn()),
      currentInitiator: vi.fn(() => undefined),
    },
    sessionController: { inspect: vi.fn(async (id: string) => ({ meta: { id } })) },
    workspaceRegistry: { archivedSessionIds: [] },
    on: vi.fn(() => {
      const id = Symbol('scheduler-listener')
      listeners.add(id)
      return () => listeners.delete(id)
    }),
    logger,
    webServer: { register: () => () => {} },
  }
  disposers.push(server(context as unknown as HostContext))
  return { listeners, logger }
}

function scheduledTask(deliveryMode: SchedulerTask['delivery']): SchedulerTask {
  return {
    id: 'resilience-task',
    delivery: deliveryMode,
    status: 'active',
    ...(deliveryMode === 'this-session' ? { sessionId: 'bound-session' } : {}),
    name: 'resilience reminder',
    prompt: 'perform the scheduled action',
    schedule: { kind: 'once', at: DUE, timeZone: 'UTC' },
    enabled: true,
    createdAt: '2026-05-31T12:00:00.000Z',
    updatedAt: '2026-05-31T12:00:00.000Z',
    nextRunAt: DUE,
  }
}

function seed(...items: SchedulerTask[]): void {
  state.set('tasks', { version: 2, tasks: structuredClone(items) })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function decode(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : structuredClone(value)
}

beforeEach(() => {
  vi.resetAllMocks()
  resetWriteQueue()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  state.clear()
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, decode(value))
  })
  vi.mocked(delivery.run).mockResolvedValue({ ok: true })
  vi.mocked(executor.run).mockResolvedValue({ ok: true })
  host = installHost()
})

afterEach(async () => {
  for (const release of releases.splice(0))
    release()
  await vi.advanceTimersByTimeAsync(0)
  for (const stop of stops.splice(0))
    await stop()
  await scheduler.stop()
  for (const dispose of disposers.splice(0))
    dispose()
  resetWriteQueue()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduler resilience', () => {
  it('coalesces periodic ticks behind a blocked delivery so the next mutation can acquire the task queue', async () => {
    seed()
    const stop = scheduler.start(1)
    stops.push(stop)
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.accepted.size).toBe(0)

    const target = scheduledTask('this-session')
    const mutationTarget: SchedulerTask = {
      ...scheduledTask('new-session'),
      id: 'queued-mutation',
      schedule: { kind: 'once', at: '2026-06-02T12:00:00.000Z', timeZone: 'UTC' },
      nextRunAt: '2026-06-02T12:00:00.000Z',
    }
    seed(target, mutationTarget)
    const pending: OperationResult = { ok: false, code: 'delivery_pending', error: 'Session persistence did not acknowledge the reminder' }
    const first = deferred<OperationResult>()
    const backlog = deferred<OperationResult>()
    releases.push(() => first.resolve(pending), () => backlog.resolve(pending))
    vi.mocked(delivery.run).mockImplementationOnce(() => first.promise).mockImplementation(() => backlog.promise)

    await vi.advanceTimersByTimeAsync(1)
    expect(delivery.run).toHaveBeenCalledWith(target, 'schedule', DUE)
    await vi.advanceTimersByTimeAsync(1000)
    expect(delivery.run).toHaveBeenCalledTimes(1)

    let mutationResult: Awaited<ReturnType<typeof task.toggle>> | undefined
    const mutation = task.toggle(mutationTarget.id, false).then((result) => {
      mutationResult = result
      return result
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mutationResult).toBeUndefined()

    first.resolve(pending)
    await vi.advanceTimersByTimeAsync(0)
    expect(mutationResult).toMatchObject({ ok: true, task: { id: mutationTarget.id, enabled: false } })
    expect(await mutation).toMatchObject({ ok: true, task: { enabled: false } })
    expect(await task.get(mutationTarget.id)).toMatchObject({ enabled: false })
    expect(delivery.run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(delivery.run).toHaveBeenCalledTimes(2)
    backlog.resolve(pending)
    await vi.advanceTimersByTimeAsync(0)
    await stop()
    stops.splice(stops.indexOf(stop), 1)
    expect(host.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('suppresses automatic re-execution after all terminal history writes reject until an explicit drive', async () => {
    const target = scheduledTask('new-session')
    seed(target)
    const persistenceError = new Error('terminal history write rejected')
    let rejectTerminal = true
    const terminalWrites: Array<{ id: string, status: SchedulerRun['status'] }> = []
    const createdSessions: Array<{ sessionId: string, trigger: SchedulerRun['trigger'], scheduledFor: string }> = []
    vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
      const saved = decode(value)
      if (key === 'history' && rejectTerminal) {
        const terminal = (saved as { records: SchedulerRun[] }).records.find(record => record.status === 'succeeded' || record.status === 'failed')
        if (terminal) {
          terminalWrites.push({ id: terminal.id, status: terminal.status })
          throw persistenceError
        }
      }
      state.set(key, saved)
    })
    vi.mocked(executor.run).mockImplementation(async (accepted, trigger, scheduledFor) => {
      const sequence = createdSessions.length + 1
      const sessionId = `created-session-${sequence}`
      const run: SchedulerRun = {
        id: `accepted-run-${sequence}`,
        taskId: accepted.id,
        taskName: accepted.name,
        prompt: accepted.prompt,
        trigger,
        status: 'running',
        scheduledFor: scheduledFor!,
        startedAt: new Date().toISOString(),
        sessionId,
      }
      await runs.save(run, accepted)
      createdSessions.push({ sessionId, trigger, scheduledFor: run.scheduledFor })
      try {
        await runs.save({ ...run, status: 'succeeded', finishedAt: new Date().toISOString() })
        return { ok: true, sessionId }
      }
      catch {
        await runs.save({ ...run, status: 'failed', finishedAt: new Date().toISOString(), error: persistenceError.message })
        return { ok: false, sessionId, error: persistenceError.message }
      }
    })

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    expect(terminalWrites).toEqual([
      { id: 'accepted-run-1', status: 'succeeded' },
      { id: 'accepted-run-1', status: 'failed' },
    ])
    expect(createdSessions).toEqual([{ sessionId: 'created-session-1', trigger: 'schedule', scheduledFor: DUE }])
    expect(runtime.running.has(target.id)).toBe(false)
    expect(runtime.accepted.size).toBe(0)
    expect(await task.get(target.id)).toEqual(target)
    expect(await runs.list(target.id)).toMatchObject([{ id: 'accepted-run-1', status: 'running', scheduledFor: DUE }])
    expect(await history.journals(target.id)).toMatchObject([{ id: 'accepted-run-1', run: { status: 'running' } }])
    expect(host.logger.warn).toHaveBeenCalledWith('dsh-tauri-scheduler: new-session run failed', persistenceError)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    expect(createdSessions).toHaveLength(1)
    expect(runtime.failed.has(target.id)).toBe(true)
    expect(terminalWrites).toHaveLength(2)
    expect(await task.get(target.id)).toEqual(target)

    rejectTerminal = false
    expect(await scheduler.trigger(target.id)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(createdSessions).toEqual([
      { sessionId: 'created-session-1', trigger: 'schedule', scheduledFor: DUE },
      { sessionId: 'created-session-2', trigger: 'manual', scheduledFor: NOW },
    ])
    expect(runtime.failed.has(target.id)).toBe(false)
    expect(runtime.running.has(target.id)).toBe(false)
  })
})
