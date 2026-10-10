import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PendingDelivery, SchedulerTask } from '../types'
import { Context } from '@deepseek-ai/cordis'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWriteQueue, runtime } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { delivery } from './delivery'
import { history } from './history'
import { scheduler } from './scheduler'
import { task } from './task'

vi.mock('../storage', async () => {
  const { createStorage } = await import('unstorage')
  return { storage: createStorage() }
})

const now = '2026-06-01T12:15:00.000Z'
const due = '2026-06-01T12:00:00.000Z'
const sessionId = SessionId('recovery-message-session')
const target: SchedulerTask = {
  id: 'recovery-message-task',
  delivery: 'this-session',
  status: 'active',
  sessionId,
  name: 'recover consumed reminder',
  prompt: 'preserve the original delivery identity',
  schedule: { kind: 'once', at: due, timeZone: 'UTC' },
  enabled: true,
  createdAt: '2026-05-31T12:00:00.000Z',
  updatedAt: '2026-05-31T12:00:00.000Z',
  nextRunAt: due,
}
const contexts: Context[] = []
const disposers: Array<() => void> = []

function createMessage(): UserMessage {
  return llmModule.createUserMessage({
    content: [{ type: 'text', text: target.prompt }],
    source: { kind: 'schedule', form: 'notice', summary: target.name },
  })
}

function createHarness() {
  const session = Session.create(sessionId)
  const events: SessionEvent[] = []
  const inboxTarget: InboxTarget = 'next-turn'
  const appendInbox = (message: UserMessage) => {
    const event = session.append('agent/inbox/spliced', { target: inboxTarget, start: 0, inserted: [message] })
    events.push(event)
    return event
  }
  const appendMessage = (message: UserMessage) => {
    const event = session.append('user/message', message, { surfaceOp: 'append' })
    events.push(event)
    return event
  }
  const followup = vi.fn(appendInbox)
  const agent = { session, runningStatus: 'running', followup, whenIdle: vi.fn(), steer: vi.fn(), inject: vi.fn() }
  const inspect = vi.fn(async () => ({ meta: session.header, inheritedEventCount: session.inheritedEventCount, events: [...events] }))
  const resolveAgent = vi.fn(async () => ({ agent }))
  const flush = vi.fn(async (flushedSession: Session) => {
    expect(flushedSession).toBe(session)
    expect(await history.query({ taskId: target.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    expect(await task.get(target.id)).toEqual(target)
    return true
  })
  const context = new Context()
  contexts.push(context)
  const services: Record<string, unknown> = {
    agents: { currentInitiator: vi.fn(), withoutInitiator: <T>(operation: () => T): T => operation() },
    sessionController: { inspect, resolveAgent },
    sessions: { flush },
    workspaceRegistry: { archivedSessionIds: [] },
    webServer: { register: () => () => {} },
  }
  for (const [name, value] of Object.entries(services))
    context.provide(name, value)
  context.accessor('loader', { get: () => ({ import: vi.fn(async () => llmModule), unwrapExports: (value: unknown) => value }) })
  disposers.push(server(context))
  return { session, events, appendInbox, appendMessage, agent, followup, inspect, resolveAgent, flush }
}

async function prepare(message: UserMessage): Promise<PendingDelivery> {
  await storage.setItem('tasks', { version: 2, tasks: [structuredClone(target)] })
  const pending: PendingDelivery = { task: target, trigger: 'schedule', scheduledAt: due, deliveredAt: due, message }
  await history.prepare(pending)
  resetWriteQueue()
  expect(runtime.pending.size).toBe(0)
  return pending
}

async function assertCompleted(message: UserMessage): Promise<void> {
  await expect(history.pending(target.id)).resolves.toEqual([])
  await expect(history.journals(target.id)).resolves.toEqual([])
  expect(runtime.pending.size).toBe(0)
  expect(runtime.flushes.size).toBe(0)
  const page = await history.query({ taskId: target.id, limit: 10 })
  expect(page).toMatchObject({ ok: true, records: [{ id: message.id, messageId: message.id, scheduledAt: due, deliveredAt: now }], runs: [] })
  if (!page.ok)
    throw new Error(page.error)
  expect(page.records).toHaveLength(1)
  expect(await task.get(target.id)).toMatchObject({ status: 'inactive', lastRunAt: now })
  expect(await task.get(target.id)).not.toHaveProperty('nextRunAt')
  await scheduler.tick()
  expect(await history.query({ taskId: target.id, limit: 10 })).toEqual(page)
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetWriteQueue()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  await storage.clear()
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await storage.clear()
  resetWriteQueue()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('durable delivery identity after cold Session recovery', () => {
  it('recognizes a consumed user/message with data.id and no inbox event, then flushes one original receipt without followup', async () => {
    const host = createHarness()
    const message = createMessage()
    await prepare(message)
    const event = host.appendMessage(message)
    expect(event.data.id).toBe(message.id)
    expect(event.data).not.toHaveProperty('message')
    expect(host.events.map(item => item.type)).toEqual(['user/message'])
    await expect(delivery.run(target, 'schedule', due)).resolves.toEqual({ ok: true })
    await assertCompleted(message)
    expect(host.inspect).toHaveBeenCalledWith(sessionId)
    expect(host.resolveAgent).toHaveBeenCalledWith(sessionId)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(host.session.deriveMessages().filter(item => item.id === message.id)).toHaveLength(1)
  })

  it('does not confuse equal prompt content with a different user/message id and admits the original pending identity once', async () => {
    const host = createHarness()
    const message = createMessage()
    const differentMessage = createMessage()
    expect(differentMessage.id).not.toBe(message.id)
    expect(differentMessage.content).toEqual(message.content)
    await prepare(message)
    host.appendMessage(differentMessage)
    await expect(delivery.run(target, 'schedule', due)).resolves.toEqual({ ok: true })
    await assertCompleted(message)
    expect(host.followup).toHaveBeenCalledExactlyOnceWith(message)
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(host.events).toMatchObject([
      { type: 'user/message', data: { id: differentMessage.id } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ id: message.id }] } },
    ])
  })

  it('recognizes the original identity still in a busy agent inbox and flushes without another followup or turn mutation', async () => {
    const host = createHarness()
    const message = createMessage()
    await prepare(message)
    const event = host.appendInbox(message)
    expect(event.data.inserted[0]?.id).toBe(message.id)
    expect(host.events.map(item => item.type)).toEqual(['agent/inbox/spliced'])
    await expect(delivery.run(target, 'schedule', due)).resolves.toEqual({ ok: true })
    await assertCompleted(message)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(host.agent.whenIdle).not.toHaveBeenCalled()
    expect(host.agent.steer).not.toHaveBeenCalled()
    expect(host.agent.inject).not.toHaveBeenCalled()
    expect(host.events).toHaveLength(1)
  })
})
