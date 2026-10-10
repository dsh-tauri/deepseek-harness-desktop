import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { HostContext, SchedulerTask } from '../types'
import * as sessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { vi } from 'vitest'
import { server } from '../server'
import { storage } from '../storage'

export const NOW = '2026-06-01T12:15:00.000Z'
export const DUE = '2026-06-01T12:00:00.000Z'
export const target: SchedulerTask = {
  id: 'deadline-task',
  delivery: 'this-session',
  status: 'active',
  sessionId: 'deadline-session',
  name: 'deadline reminder',
  prompt: 'preserve the original reminder',
  schedule: { kind: 'once', at: DUE, timeZone: 'UTC' },
  enabled: true,
  createdAt: '2026-05-31T12:00:00.000Z',
  updatedAt: '2026-05-31T12:00:00.000Z',
  nextRunAt: DUE,
}
export const unrelated: SchedulerTask = {
  id: 'unrelated-task',
  delivery: 'new-session',
  status: 'active',
  name: 'unrelated paused task',
  prompt: 'do not execute this task',
  schedule: { kind: 'once', at: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' },
  enabled: false,
  createdAt: '2026-05-31T12:00:00.000Z',
  updatedAt: '2026-05-31T12:00:00.000Z',
  nextRunAt: '2030-01-01T12:00:00.000Z',
}

export interface SessionInspection {
  meta: { id: string }
  events: Array<{ type: string, data: { inserted: UserMessage[] } }>
}

const state = new Map<string, unknown>()
const releases: Array<() => void> = []
const operations: Promise<unknown>[] = []

export function seed(...tasks: SchedulerTask[]): void {
  state.set('tasks', { version: 2, tasks: structuredClone(tasks) })
}

export function resetStorage(): void {
  state.clear()
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
  })
}

export function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  releases.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}

export function observe<T>(promise: Promise<T>) {
  const settled = vi.fn()
  const completion = promise.then((value) => {
    settled(value)
    return value
  })
  operations.push(completion)
  return { promise: completion, settled }
}

export async function releaseOperations(): Promise<void> {
  for (const release of releases.splice(0))
    release()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.all(operations.splice(0))
}

export function installHost() {
  const session = { id: 'deadline-session', seq: 0 }
  const events: SessionInspection['events'] = []
  const followup = vi.fn((message: UserMessage) => {
    events.push({ type: 'agent/inbox/spliced', data: { inserted: [structuredClone(message)] } })
  })
  const agent = { session, followup, whenIdle: vi.fn(), steer: vi.fn(), inject: vi.fn() }
  const inspect = vi.fn<(id: string) => Promise<SessionInspection>>(async id => ({ meta: { id }, events: structuredClone(events) }))
  const resolveAgent = vi.fn<(id: string) => Promise<{ agent: typeof agent }>>(async () => ({ agent }))
  const flush = vi.fn<(session: unknown) => Promise<boolean>>(async () => true)
  const create = vi.fn()
  const logger = { warn: vi.fn() }
  const loader = {
    import: vi.fn<(name: string) => Promise<unknown>>(async (name) => {
      if (name === '@deepseek-ai/dsh-llm')
        return llmModule
      if (name === '@deepseek-ai/dsh-api-session-controller')
        return sessionControllerModule
      throw new Error(`Unexpected platform import: ${name}`)
    }),
    unwrapExports: vi.fn((exports: unknown) => exports),
  }
  const context = {
    agents: { create, currentInitiator: () => undefined, withoutInitiator: <T>(fn: () => T): T => fn() },
    sessionController: { inspect, resolveAgent },
    sessions: { flush },
    workspaceRegistry: { archivedSessionIds: [] },
    logger,
    loader,
    webServer: { register: () => () => {} },
  }
  const dispose = server(context as unknown as HostContext)
  return { agent, session, events, followup, inspect, resolveAgent, flush, create, loader, logger, dispose }
}
