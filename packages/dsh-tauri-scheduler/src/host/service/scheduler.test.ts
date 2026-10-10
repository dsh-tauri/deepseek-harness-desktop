import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { HostContext, SchedulerTask } from '../types'
import type { SetupAgentLike } from '../utils/agent-runtime.types'
import type { SessionEventLike } from './executor.utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue, runtime } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { history } from './history'
import { recovery } from './recovery'
import { runs } from './runs'
import { scheduler } from './scheduler'
import { task } from './task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const now = '2026-06-01T12:15:00.000Z'
const due = '2026-06-01T12:00:00.000Z'
const fixture: SchedulerTask = {
  id: 'task-1',
  delivery: 'this-session',
  status: 'active',
  sessionId: 'session-1',
  name: 'reminder',
  prompt: 'original prompt',
  schedule: { kind: 'once', at: due, timeZone: 'UTC' },
  enabled: true,
  createdAt: '2026-05-31T12:00:00.000Z',
  updatedAt: '2026-05-31T12:00:00.000Z',
  nextRunAt: due,
}

interface AgentInput {
  sessionId: string
  meta: { cwd: string, agentPreset: string }
  agentOptions: { provider?: string, model?: string }
  setup: (agentCtx: unknown, createdAgent?: SetupAgentLike) => Promise<void>
}

interface NewAgentControl {
  session: { id: string, seq: number }
  finish: () => void
}

const state = new Map<string, unknown>()
const disposers: Array<() => void> = []
const stops: Array<() => Promise<void>> = []
let host: ReturnType<typeof installHost>

function installHost() {
  let messageSequence = 0
  let autoFinish = true
  const archivedSessionIds: string[] = []
  const boundEvents: SessionEventLike[] = []
  const boundSession = { id: 'session-1', seq: 0 }
  const eventListeners = new Set<(target: unknown, event: SessionEventLike) => void>()
  const lifecycleListeners = new Map<string, (...args: never[]) => unknown>()
  const followup = vi.fn((message: UserMessage) => {
    boundEvents.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
  })
  const boundAgent = { session: boundSession, runningStatus: 'running', followup, whenIdle: vi.fn(), steer: vi.fn(), inject: vi.fn() }
  const inspect = vi.fn(async (id: string) => {
    if (id !== 'session-1')
      throw Object.assign(new Error('Session not found'), { code: 'session/not-found' })
    return { meta: { id }, events: structuredClone(boundEvents) }
  })
  const resolveAgent = vi.fn(async (_id: string) => ({ agent: boundAgent }))
  const flush = vi.fn<(session: unknown) => Promise<boolean>>(async () => true)
  const createMessage = vi.fn((input: Omit<UserMessage, 'id' | 'role'>) => ({ ...input, role: 'user' as const, id: `message-${++messageSequence}` as MessageId }))
  const installModelSelection = vi.fn()
  const setApprovalPolicy = vi.fn()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', { createUserMessage: createMessage }],
    ['@deepseek-ai/dsh-agent', { installModelSelection }],
    ['@deepseek-ai/dsh-user-approval', { setApprovalPolicy }],
  ])
  const controls: NewAgentControl[] = []
  const create = vi.fn(async (input: AgentInput) => {
    const session = { id: input.sessionId, seq: 0 }
    const agentContext = {}
    let finishIdle = () => {}
    const idle = new Promise<void>((resolve) => {
      finishIdle = resolve
    })
    const emit = (type: string, data: Record<string, unknown>) => {
      session.seq += 1
      for (const listener of eventListeners)
        listener(session, { seq: session.seq, type, data })
    }
    const finish = () => {
      emit('turn/end', { reason: { kind: 'completed' } })
      finishIdle()
    }
    controls.push({ session, finish })
    await input.setup(agentContext, { session })
    return {
      agent: {
        session,
        followup: vi.fn(() => {
          emit('turn/start', {})
          if (autoFinish)
            finish()
        }),
        whenIdle: vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(idle),
        cancel: vi.fn(finish),
      },
    }
  })
  const workspace = { path: '/virtual/scheduler-workspace', status: vi.fn(async () => 'ok'), attachSession: vi.fn(async () => {}) }
  const workspaceRegistry = { archivedSessionIds, get: vi.fn((id: string) => id === 'ws-1' ? workspace : undefined) }
  const permissionPresets = { defaultPreset: 'read-only', set: vi.fn() }
  const agentPresets = { mount: vi.fn(async () => {}) }
  const rename = vi.fn()
  const logger = { warn: vi.fn(), error: vi.fn() }
  const context = {
    agents: { create, withoutInitiator: vi.fn((fn: () => Promise<unknown>) => fn()), currentInitiator: vi.fn() },
    sessionController: { inspect, resolveAgent },
    sessions: { flush },
    workspaceRegistry,
    permissionPresets,
    agentPresets,
    get: (name: string) => name === 'sessionTitle' ? { rename } : undefined,
    loader: { import: vi.fn(async (name: string) => modules.get(name)), unwrapExports: vi.fn((value: unknown) => value) },
    on: vi.fn((name: string, listener: (...args: never[]) => unknown) => {
      if (name === 'session/event')
        eventListeners.add(listener as (target: unknown, event: SessionEventLike) => void)
      else
        lifecycleListeners.set(name, listener)
      return () => {
        eventListeners.delete(listener as (target: unknown, event: SessionEventLike) => void)
        lifecycleListeners.delete(name)
      }
    }),
    logger,
    webServer: { register: () => () => {} },
  }
  disposers.push(server(context as unknown as HostContext))
  return { followup, boundAgent, boundSession, boundEvents, inspect, resolveAgent, flush, createMessage, create, controls, workspaceRegistry, permissionPresets, agentPresets, installModelSelection, setApprovalPolicy, rename, context, lifecycleListeners, logger, setAutoFinish: (value: boolean) => {
    autoFinish = value
  } }
}

function seed(...items: SchedulerTask[]): void {
  state.set('tasks', { version: 2, tasks: structuredClone(items) })
}

function newTask(id = 'new-task'): SchedulerTask {
  const { sessionId: _sessionId, ...base } = fixture
  return { ...base, id, delivery: 'new-session', workspaceId: 'ws-1', permission: 'read-only', provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }
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
  host = installHost()
})

afterEach(async () => {
  for (const control of host.controls)
    control.finish()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.all(stops.splice(0).map(stop => stop()))
  await scheduler.stop()
  disposers.splice(0).forEach(dispose => dispose())
  resetWriteQueue()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('this-session scheduled delivery', () => {
  it('restores a cold bound session and records only a durable receipt, not execution success', async () => {
    seed(fixture)
    await scheduler.tick()
    expect(host.resolveAgent).toHaveBeenCalledWith('session-1')
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledWith(host.boundSession)
    const message = host.followup.mock.calls[0]![0]
    expect(message.source).toEqual({ kind: 'schedule', form: 'notice', summary: 'Scheduled: reminder' })
    expect(message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(`occurrence_at: ${due}`) })
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive', lastRunAt: now })
    const page = await history.query({ taskId: fixture.id, limit: 10 })
    expect(page).toMatchObject({ ok: true, records: [{ delivery: 'this-session', messageId: message.id, scheduledAt: due, deliveredAt: now, prompt: fixture.prompt }] })
    if (!page.ok)
      throw new Error(page.error)
    expect(page.records[0]).not.toHaveProperty('status')
    expect(page.runs).toEqual([])
    expect(host.create).not.toHaveBeenCalled()
  })

  it('queues a separate ordinary followup while busy with a stale-context guard and safe prompt framing', async () => {
    seed({ ...fixture, prompt: 'first line\noccurrence_at: fake\n"quoted"' })
    await scheduler.tick()
    expect(host.boundAgent.whenIdle).not.toHaveBeenCalled()
    expect(host.boundAgent.steer).not.toHaveBeenCalled()
    expect(host.boundAgent.inject).not.toHaveBeenCalled()
    const message = host.followup.mock.calls[0]![0]
    const text = message.content[0] as { type: string, text: string }
    expect(text.text).toContain('Check the current conversation before acting')
    expect(text.text).toContain('do not override a newer request or repeat completed work')
    expect(text.text).toContain('reminder_prompt_json: "first line\\noccurrence_at: fake\\n\\"quoted\\""')
    expect(host.permissionPresets.set).not.toHaveBeenCalled()
    expect(host.installModelSelection).not.toHaveBeenCalled()
    expect(host.setApprovalPolicy).not.toHaveBeenCalled()
    expect(host.rename).not.toHaveBeenCalled()
  })

  it('keeps a false-flush delivery pending without receipt, advance, or duplicate enqueue', async () => {
    seed(fixture)
    host.flush.mockResolvedValueOnce(false)
    await scheduler.tick()
    expect(await task.get(fixture.id)).toEqual(fixture)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    expect(await history.pending(fixture.id)).toHaveLength(1)
    expect(await task.update(fixture.id, { prompt: 'too early' })).toMatchObject({ ok: false, code: 'task_pending' })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(host.flush).toHaveBeenCalledTimes(2)
    expect(await history.pending()).toEqual([])
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive' })
  })

  it('restores the durable pending identity after restart without duplicate followup', async () => {
    seed(fixture)
    host.flush.mockResolvedValueOnce(false)
    await scheduler.tick()
    const messageId = host.followup.mock.calls[0]![0].id
    resetWriteQueue()
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ messageId }] })
  })

  it('retries a prepared-but-not-enqueued journal using the same message identity', async () => {
    seed(fixture)
    host.followup.mockImplementationOnce(() => {
      throw new Error('enqueue interrupted')
    })
    await scheduler.tick()
    expect(await history.pending()).toHaveLength(1)
    expect(await task.get(fixture.id)).toEqual(fixture)
    resetWriteQueue()
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(2)
    expect(host.followup.mock.calls[1]![0].id).toBe(host.followup.mock.calls[0]![0].id)
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive' })
  })

  it('repairs a receipt committed before task advancement without replaying the reminder', async () => {
    seed(fixture)
    await history.commit({ task: fixture, trigger: 'schedule', scheduledAt: due, deliveredAt: now, message: { id: 'already-delivered' as MessageId, role: 'user', content: [], source: { kind: 'schedule' } } })
    await scheduler.tick()
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive', lastRunAt: now })
    expect(host.resolveAgent).not.toHaveBeenCalled()
    expect(host.followup).not.toHaveBeenCalled()
  })

  it('recognizes a followup accepted before throwing and never injects its identity twice', async () => {
    seed(fixture)
    host.followup.mockImplementationOnce((message) => {
      host.boundEvents.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
      throw new Error('accepted before producer failure')
    })
    await scheduler.tick()
    const messageId = host.followup.mock.calls[0]![0].id
    expect(await history.pending()).toHaveLength(1)
    resetWriteQueue()
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ messageId }] })
  })

  it('persists no receipt when the journal or acknowledgement write fails and reuses accepted identity', async () => {
    seed(fixture)
    let failHistory = true
    vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
      if (key === 'history' && failHistory)
        throw new Error('history unavailable')
      state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
    })
    await scheduler.tick()
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).not.toHaveBeenCalled()
    expect(await task.get(fixture.id)).toEqual(fixture)
    failHistory = false
    resetWriteQueue()
    host.flush.mockImplementationOnce(async () => {
      failHistory = true
      return true
    })
    await scheduler.tick()
    const messageId = host.followup.mock.calls[0]![0].id
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    expect(await task.get(fixture.id)).toEqual(fixture)
    failHistory = false
    resetWriteQueue()
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ messageId }] })
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive' })
  })

  it('repairs a task-write failure after committing a receipt without re-enqueue or rewriting history', async () => {
    seed(fixture)
    let failTaskWrite = true
    vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
      if (key === 'tasks' && failTaskWrite) {
        failTaskWrite = false
        throw new Error('task commit unavailable')
      }
      state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
    })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.pending()).toEqual([])
    expect(await history.journals()).toHaveLength(1)
    const receipt = await history.query({ taskId: fixture.id, limit: 10 })
    await scheduler.tick()
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive' })
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toEqual(receipt)
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(runtime.pending.size).toBe(0)
    expect(await history.journals()).toEqual([])
  })

  it('folds missed recurring occurrences to the latest due slot and advances from it', async () => {
    seed({ ...fixture, schedule: { kind: 'interval', everyMinutes: 30, anchor: '2026-05-31T12:00:00.000Z', timeZone: 'UTC' }, nextRunAt: '2026-05-31T12:30:00.000Z' })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ scheduledAt: due }] })
    expect(await task.get(fixture.id)).toMatchObject({ status: 'active', nextRunAt: '2026-06-01T12:30:00.000Z' })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('preserves interval phase and skips slots elapsed before flush acknowledgement', async () => {
    const target: SchedulerTask = { ...fixture, schedule: { kind: 'interval', everyMinutes: 15, anchor: '2026-06-01T12:00:00.000Z', timeZone: 'UTC' }, nextRunAt: '2026-06-01T12:02:17.000Z' }
    seed(target)
    host.flush.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-06-01T13:32:17.000Z'))
      return true
    })
    await scheduler.tick()
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ scheduledAt: '2026-06-01T12:02:17.000Z', deliveredAt: '2026-06-01T13:32:17.000Z' }] })
    expect(await task.get(fixture.id)).toMatchObject({ nextRunAt: '2026-06-01T13:47:17.000Z' })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('repairs a delayed receipt by skipping elapsed slots instead of replaying them', async () => {
    const target: SchedulerTask = { ...fixture, schedule: { kind: 'interval', everyMinutes: 15, anchor: due, timeZone: 'UTC' }, nextRunAt: '2026-06-01T12:02:17.000Z' }
    seed(target)
    await history.commit({ task: target, trigger: 'schedule', scheduledAt: target.nextRunAt!, deliveredAt: now, message: { id: 'durable-receipt' as MessageId, role: 'user', content: [], source: { kind: 'schedule' } } })
    vi.setSystemTime(new Date('2026-06-01T14:02:17.000Z'))
    await scheduler.tick()
    expect(await task.get(fixture.id)).toMatchObject({ nextRunAt: '2026-06-01T14:17:17.000Z', lastRunAt: now })
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.resolveAgent).not.toHaveBeenCalled()
    expect(await history.journals()).toEqual([])
  })

  it('never advances an edited task from an old receipt snapshot', async () => {
    seed(fixture)
    await history.commit({ task: fixture, trigger: 'schedule', scheduledAt: due, deliveredAt: now, message: { id: 'old-receipt' as MessageId, role: 'user', content: [], source: { kind: 'schedule' } } })
    const update = await task.update(fixture.id, { prompt: 'new explicit request', enabled: false }, fixture)
    if (!update.ok)
      throw new Error(update.error)
    await scheduler.tick()
    expect(await task.get(fixture.id)).toEqual(update.task)
    expect(host.followup).not.toHaveBeenCalled()
    expect(await history.journals()).toEqual([])
  })

  it.each(['pause', 'edit', 'stop', 'delete'] as const)('discards an unaccepted pending identity after %s and restart', async (change) => {
    seed(fixture)
    host.followup.mockImplementationOnce(() => {
      throw new Error('not accepted')
    })
    await scheduler.tick()
    const oldId = host.followup.mock.calls[0]![0].id
    if (change === 'pause')
      expect(await task.toggle(fixture.id, false)).toMatchObject({ ok: true })
    if (change === 'edit')
      expect(await task.update(fixture.id, { prompt: 'new prompt', enabled: false })).toMatchObject({ ok: true })
    if (change === 'stop')
      await task.stopSession('session-1')
    if (change === 'delete')
      await task.remove(fixture.id)
    resetWriteQueue()
    await scheduler.tick()
    expect(await history.pending()).toEqual([])
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    if (change === 'edit') {
      expect(await task.toggle(fixture.id, true)).toMatchObject({ ok: true })
      await scheduler.tick()
      expect(host.followup).toHaveBeenCalledTimes(2)
      expect(host.followup.mock.calls[1]![0].id).not.toBe(oldId)
      expect(host.followup.mock.calls[1]![0].content[0]).toMatchObject({ text: expect.stringContaining('reminder_prompt_json: "new prompt"') })
    }
  })

  it('flushes an already accepted pending identity after stop without advancing or re-enqueuing', async () => {
    seed(fixture)
    host.flush.mockResolvedValueOnce(false)
    await scheduler.tick()
    const messageId = host.followup.mock.calls[0]![0].id
    await task.stopSession('session-1')
    const stopped = await task.get(fixture.id)
    resetWriteQueue()
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await task.get(fixture.id)).toEqual(stopped)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ messageId }] })
  })

  it('rechecks wall time after cold restoration before accepting an occurrence', async () => {
    seed(fixture)
    host.resolveAgent.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-06-01T11:59:00.000Z'))
      return { agent: host.boundAgent }
    })
    await scheduler.tick()
    expect(host.followup).not.toHaveBeenCalled()
    expect(runtime.failed.has(fixture.id)).toBe(false)
    vi.setSystemTime(new Date(now))
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('does not use stale batch time after the preceding delivery rolls the clock back', async () => {
    seed(fixture, { ...fixture, id: 'task-2', nextRunAt: '2026-06-01T12:10:00.000Z', schedule: { kind: 'once', at: '2026-06-01T12:10:00.000Z', timeZone: 'UTC' } })
    host.flush.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-06-01T11:50:00.000Z'))
      return true
    })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await task.get('task-2')).toMatchObject({ status: 'active', nextRunAt: '2026-06-01T12:10:00.000Z' })
    vi.setSystemTime(new Date(now))
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(2)
  })

  it('manual delivery uses now and preserves the next scheduled occurrence even while paused', async () => {
    seed({ ...fixture, enabled: false })
    expect(await scheduler.trigger(fixture.id)).toEqual({ ok: true })
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ trigger: 'manual', scheduledAt: now }] })
    expect(await task.get(fixture.id)).toMatchObject({ enabled: false, status: 'active', nextRunAt: due })
  })

  it('refuses archived/missing targets and a wrong restored session without delivery or advancement', async () => {
    seed(fixture)
    host.workspaceRegistry.archivedSessionIds.push('session-1')
    await scheduler.tick()
    expect(host.resolveAgent).not.toHaveBeenCalled()
    expect(await task.get(fixture.id)).toEqual(fixture)
    host.workspaceRegistry.archivedSessionIds.splice(0)
    host.inspect.mockRejectedValueOnce({ code: 'session/not-found' })
    expect(await scheduler.trigger(fixture.id)).toMatchObject({ ok: false, code: 'session_not_found' })
    host.resolveAgent.mockResolvedValueOnce({ agent: { ...host.boundAgent, session: { id: 'different', seq: 0 } } })
    expect(await scheduler.trigger(fixture.id)).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(host.followup).not.toHaveBeenCalled()
  })

  it('rechecks archive status after cold restoration', async () => {
    seed(fixture)
    host.resolveAgent.mockImplementationOnce(async () => {
      host.workspaceRegistry.archivedSessionIds.push('session-1')
      return { agent: host.boundAgent }
    })
    await scheduler.tick()
    expect(host.followup).not.toHaveBeenCalled()
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
  })

  it('pause blocks due occurrences and terminal status blocks both automatic and manual execution', async () => {
    seed({ ...fixture, enabled: false })
    await scheduler.tick()
    expect(host.followup).not.toHaveBeenCalled()
    expect(await task.toggle(fixture.id, true)).toMatchObject({ ok: true })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await scheduler.trigger(fixture.id)).toMatchObject({ ok: false, code: 'task_inactive' })
    await scheduler.tick()
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('deletion racing an accepted delivery cannot resurrect the task', async () => {
    seed(fixture)
    let acknowledge = (_value: boolean) => {}
    host.flush.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      acknowledge = resolve
    }))
    const tick = scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.followup).toHaveBeenCalledTimes(1)
    const removal = task.remove(fixture.id)
    acknowledge(true)
    await tick
    expect(await removal).toEqual({ ok: true })
    expect(await task.get(fixture.id)).toBeNull()
    await scheduler.tick()
    expect(await task.get(fixture.id)).toBeNull()
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('drains an already accepted durability barrier before unloading and rejects later work', async () => {
    seed(fixture)
    let acknowledge = (_value: boolean) => {}
    host.flush.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      acknowledge = resolve
    }))
    const tick = scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    acknowledge(true)
    await tick
    await stopping
    expect(stopped).toBe(true)
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [{ messageId: expect.any(String) }] })
    expect(await scheduler.trigger(fixture.id)).toMatchObject({ ok: false, code: 'scheduler_stopping' })
  })
})

describe('new-session runtime and shared lifecycle', () => {
  it('keeps resource-scoped new-session execution, history, and real due occurrence', async () => {
    seed(newTask())
    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: '/virtual/scheduler-workspace', agentPreset: 'standard' }, agentOptions: { provider: 'test-provider', model: 'test-model' } }))
    expect(host.permissionPresets.set).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^task-/) }), 'read-only')
    expect(host.installModelSelection).toHaveBeenCalledWith(expect.anything(), { current: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }, assembled: undefined })
    expect(await history.query({ taskId: 'new-task', limit: 10 })).toMatchObject({ ok: true, records: [{ delivery: 'new-session', status: 'succeeded', scheduledFor: due, startedAt: now, prompt: fixture.prompt }] })
    expect(await task.get('new-task')).toMatchObject({ status: 'inactive' })
    expect(host.followup).not.toHaveBeenCalled()
  })

  it('advances a long new-session run from durable phase to a strictly future slot', async () => {
    seed({ ...newTask(), schedule: { kind: 'interval', everyMinutes: 15, anchor: due, timeZone: 'UTC' }, nextRunAt: '2026-06-01T12:02:17.000Z' })
    host.setAutoFinish(false)
    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(new Date('2026-06-01T13:02:17.000Z'))
    host.controls[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await task.get('new-task')).toMatchObject({ nextRunAt: '2026-06-01T13:17:17.000Z', lastRunAt: '2026-06-01T13:02:17.000Z' })
    expect(await history.query({ taskId: 'new-task', limit: 10 })).toMatchObject({ ok: true, records: [{ status: 'succeeded', scheduledFor: '2026-06-01T12:02:17.000Z' }] })
    await scheduler.tick()
    expect(host.create).toHaveBeenCalledTimes(1)
    expect(await history.journals()).toEqual([])
  })

  it('repairs a finished new-session journal after crash without executing the one-off again', async () => {
    const target = newTask()
    seed(target)
    const saved = { id: 'completed-run', taskId: target.id, taskName: target.name, prompt: target.prompt, trigger: 'schedule' as const, status: 'running' as const, scheduledFor: due, startedAt: now }
    await runs.save(saved, target)
    await runs.save({ ...saved, status: 'succeeded', finishedAt: now })
    resetWriteQueue()
    await recovery.recover()
    await scheduler.tick()
    expect(await task.get(target.id)).toMatchObject({ status: 'inactive', lastRunAt: now })
    expect(host.create).not.toHaveBeenCalled()
    expect(await history.journals()).toEqual([])
    expect(await history.query({ taskId: target.id, limit: 10 })).toMatchObject({ ok: true, records: [{ id: saved.id, status: 'succeeded' }] })
  })

  it('recovers an interrupted new-session journal and folds missed slots without a second run', async () => {
    const target: SchedulerTask = { ...newTask(), schedule: { kind: 'interval', everyMinutes: 15, anchor: due, timeZone: 'UTC' }, nextRunAt: '2026-06-01T12:02:17.000Z' }
    seed(target)
    await runs.save({ id: 'interrupted-run', taskId: target.id, taskName: target.name, trigger: 'schedule', status: 'running', scheduledFor: target.nextRunAt!, startedAt: now }, target)
    vi.setSystemTime(new Date('2026-06-01T14:02:17.000Z'))
    await recovery.recover()
    await scheduler.tick()
    expect(await task.get(target.id)).toMatchObject({ status: 'active', nextRunAt: '2026-06-01T14:17:17.000Z' })
    expect(host.create).not.toHaveBeenCalled()
    expect(await history.query({ taskId: target.id, limit: 10 })).toMatchObject({ ok: true, records: [{ status: 'interrupted', error: 'host_interrupted' }] })
  })

  it('cannot consume an edited task using an old new-session journal snapshot', async () => {
    const target = newTask()
    seed(target)
    await runs.save({ id: 'old-run', taskId: target.id, taskName: target.name, trigger: 'schedule', status: 'succeeded', scheduledFor: due, startedAt: now, finishedAt: now }, target)
    const updated = await task.update(target.id, { prompt: 'replacement', enabled: false }, target)
    if (!updated.ok)
      throw new Error(updated.error)
    await scheduler.tick()
    expect(await task.get(target.id)).toEqual(updated.task)
    expect(host.create).not.toHaveBeenCalled()
    expect(await history.journals()).toEqual([])
  })

  it('manual new-session execution preserves the automatic occurrence and rejects a concurrent duplicate', async () => {
    seed(newTask())
    host.setAutoFinish(false)
    expect(await scheduler.trigger('new-task')).toEqual({ ok: true })
    expect(await scheduler.trigger('new-task')).toMatchObject({ ok: false, code: 'task_busy' })
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await task.get('new-task')).toMatchObject({ status: 'active', nextRunAt: due, lastRunAt: now })
    expect(await history.query({ taskId: 'new-task', limit: 10 })).toMatchObject({ ok: true, records: [{ trigger: 'manual', scheduledFor: now }] })
  })

  it('new-session completion after deletion does not resurrect the original task', async () => {
    seed(newTask())
    host.setAutoFinish(false)
    await scheduler.trigger('new-task')
    await vi.advanceTimersByTimeAsync(0)
    expect(await task.remove('new-task')).toEqual({ ok: true })
    host.controls[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await task.get('new-task')).toBeNull()
    expect(await history.query({ taskId: 'new-task', limit: 10 })).toMatchObject({ ok: true, records: [{ status: 'succeeded' }] })
  })

  it('caps new-session concurrency while still delivering reminders without a waiting flag', async () => {
    seed(...Array.from({ length: 5 }, (_, index) => newTask(`job-${index}`)), fixture)
    host.setAutoFinish(false)
    await scheduler.tick()
    expect(runtime.running.size).toBe(4)
    expect(await scheduler.waitingIds()).toEqual(new Set(['job-4']))
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect(await scheduler.trigger('job-4')).toMatchObject({ ok: false, code: 'scheduler_capacity' })
  })

  it('registers schedule activity for paused active records and ends bindings on session-stop', async () => {
    seed({ ...fixture, enabled: false }, newTask())
    const stop = scheduler.start(1000)
    stops.push(stop)
    await vi.advanceTimersByTimeAsync(0)
    const activity = host.lifecycleListeners.get('workspace/session-activity') as unknown as (request: { sessionId: string }, next: () => Promise<unknown[]>) => Promise<unknown[]>
    const ended = host.lifecycleListeners.get('workspace/session-stop') as unknown as (request: { sessionId: string }) => Promise<void>
    expect(await activity({ sessionId: 'session-1' }, async () => [{ kind: 'other', items: [] }])).toEqual([{ kind: 'schedule', items: [{ id: fixture.id, label: fixture.name }] }, { kind: 'other', items: [] }])
    await ended({ sessionId: 'session-1' })
    expect(await task.get(fixture.id)).toMatchObject({ status: 'inactive', enabled: false })
    expect(await activity({ sessionId: 'session-1' }, async () => [])).toEqual([])
    expect(await history.query({ taskId: fixture.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    await stop()
    stops.splice(stops.indexOf(stop), 1)
    expect(host.lifecycleListeners.size).toBe(0)
  })
})
