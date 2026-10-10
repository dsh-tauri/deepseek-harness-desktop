import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PendingDelivery, SchedulerTask } from '../types'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as sessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import { ApiSessionNotFound, SessionController } from '@deepseek-ai/dsh-api-session-controller'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inject } from '../../index'
import { resetWriteQueue } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { delivery } from './delivery'
import { history } from './history'
import { task } from './task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const state = new Map<string, unknown>()
const contexts: Context[] = []
const httpServers: Server[] = []
const sessionId = 'platform-session' as SessionId
const schedule = { kind: 'once', at: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' } as const
const input = { delivery: 'this-session', sessionId, name: 'platform reminder', prompt: 'preserve this reminder', schedule } as const

async function createHarness(dependencies: readonly string[], missing = false, wrappedExports = false) {
  const root = new Context()
  contexts.push(root)
  const routes = new Map<string, WebRoute>()
  const disposeObservation = vi.fn()
  const observeSession = vi.fn(async (id: string) => ({
    header: missing ? { id } : { id, cwd: '/virtual/platform-session' },
    inheritedEventCount: 0,
    events: [],
    [Symbol.dispose]: disposeObservation,
  }))
  const agents = { currentInitiator: vi.fn<() => { session: { id: string } } | undefined>(), withoutInitiator: <T>(operation: () => T): T => operation(), get: vi.fn(() => undefined), create: vi.fn(), resume: vi.fn() }
  const workspaceRegistry = { archivedSessionIds: [] as string[] }
  const sessions = { get: vi.fn(() => undefined), flush: vi.fn(async () => true) }
  const loader = {
    import: vi.fn(async (name: string) => {
      if (name === '@deepseek-ai/dsh-api-session-controller')
        return wrappedExports ? { default: sessionControllerModule } : sessionControllerModule
      if (name === '@deepseek-ai/dsh-llm')
        return llmModule
      throw new Error(`Unexpected platform import: ${name}`)
    }),
    unwrapExports: vi.fn((value: unknown) => (value as { default?: unknown }).default ?? value),
  }
  root.accessor('loader', { get: () => loader })
  await root.plugin({
    name: 'scheduler-platform-boundaries',
    apply(ctx) {
      const values: Record<string, unknown> = {
        tools: {},
        webServer: { register: (route: WebRoute) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        } },
        agents,
        sessions,
        sessionQuery: { observeSession },
        sessionProjections: { register: vi.fn(), onChanged: vi.fn() },
        workspaceRegistry,
        agentDefaultModel: {},
        agentPresets: {},
        permissionPresets: {},
        llm: llmModule,
        attachments: { imageLimits: { maxImageBytes: 1024 } },
        fileUploads: { registerAgentResolver: () => () => {} },
        fs: {},
        fileReferences: {},
        typert: { lookups: { configure: vi.fn() }, contexts: { configureHost: vi.fn() } },
        connection: { fetch: { register: () => () => {} } },
      }
      for (const [name, value] of Object.entries(values))
        ctx.provide(name, value)
    },
  })
  await root.plugin(SessionController, { nativeOpen: false })
  const controller = root.get('sessionController') as SessionController
  let pluginContext: Context | undefined
  await root.plugin({
    name: 'scheduler-binding-platform-regression',
    inject: [...dependencies],
    apply(ctx) {
      pluginContext = ctx
      ctx.effect(() => server(ctx))
    },
  })
  const httpServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.get(pathname)
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  httpServers.push(httpServer)
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
  return { root, pluginContext, controller, agents, sessions, workspaceRegistry, observeSession, disposeObservation, loader, base }
}

function createRequest(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/tauri/scheduler/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetWriteQueue()
  state.clear()
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
  })
})

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map(httpServer => new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
  })))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  resetWriteQueue()
  vi.restoreAllMocks()
})

describe('scheduler binding against actual platform contracts', () => {
  it('declares the controller injection needed by real Cordis HTTP binding, without activating the Session', async () => {
    const harness = await createHarness(inject)
    const { sessionId: _sessionId, ...withoutBinding } = input
    const missingBinding = await createRequest(harness.base, withoutBinding)
    expect(missingBinding.status).toBe(400)
    const response = await createRequest(harness.base, input)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, task: { delivery: 'this-session', sessionId } })
    expect(harness.observeSession).toHaveBeenCalledWith(sessionId, { projectionMode: 'none' })
    expect(harness.disposeObservation).toHaveBeenCalledTimes(1)
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
    expect(harness.sessions.flush).not.toHaveBeenCalled()
  })

  it.each([false, true])('maps the actual cold inspect ApiSessionNotFound from loader exports (wrapped=%s)', async (wrappedExports) => {
    const harness = await createHarness([...inject, 'sessionController'], true, wrappedExports)
    const error: unknown = await harness.controller.inspect(sessionId).catch(reason => reason)
    expect(error).toBeInstanceOf(ApiSessionNotFound)
    expect(error).not.toHaveProperty('code')
    const exported = await harness.loader.import('@deepseek-ai/dsh-api-session-controller')
    const actualExports = wrappedExports ? harness.loader.unwrapExports(exported) : exported
    expect((actualExports as typeof sessionControllerModule).ApiSessionNotFound).toBe(ApiSessionNotFound)
    harness.loader.import.mockClear()
    harness.loader.unwrapExports.mockClear()
    const response = await createRequest(harness.base, input)
    expect(response.status, await response.clone().text()).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: '目标会话不存在', code: 'session_not_found' })
    expect(harness.loader.import).toHaveBeenCalledWith('@deepseek-ai/dsh-api-session-controller')
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
    expect(await task.list()).toEqual([])
  })

  it.each(['archived', 'missing'] as const)('allows unchanged %s binding rename and pause without inspecting or activating its Session', async (unavailable) => {
    const harness = await createHarness([...inject, 'sessionController'], unavailable === 'missing')
    if (unavailable === 'archived')
      harness.workspaceRegistry.archivedSessionIds.push(sessionId)
    const target: SchedulerTask = {
      ...input,
      id: 'unavailable-binding-task',
      enabled: true,
      status: 'active',
      nextRunAt: schedule.at,
      createdAt: '2029-01-01T00:00:00.000Z',
      updatedAt: '2029-01-01T00:00:00.000Z',
    }
    state.set('tasks', { version: 2, tasks: [target] })
    const response = await fetch(`${harness.base}/api/tauri/scheduler/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id, expected: target, name: 'renamed unavailable reminder' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, task: { name: 'renamed unavailable reminder', sessionId } })
    await expect(task.update(target.id, { enabled: false })).resolves.toMatchObject({ ok: true, task: { enabled: false, status: 'active', sessionId } })
    expect(harness.observeSession).not.toHaveBeenCalled()
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
  })

  it('still rejects resource overrides and a different actual tool initiator on an unchanged unavailable binding', async () => {
    const harness = await createHarness([...inject, 'sessionController'], true)
    const target: SchedulerTask = {
      ...input,
      id: 'authority-binding-task',
      enabled: true,
      status: 'active',
      nextRunAt: schedule.at,
      createdAt: '2029-01-01T00:00:00.000Z',
      updatedAt: '2029-01-01T00:00:00.000Z',
    }
    state.set('tasks', { version: 2, tasks: [target] })
    await expect(task.update(target.id, { permission: 'danger-full-access' })).resolves.toMatchObject({ ok: false, code: 'task_invalid' })
    harness.agents.currentInitiator.mockReturnValue({ session: { id: 'different-initiator' } })
    await expect(task.update(target.id, { name: 'unauthorized change' })).resolves.toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(await task.get(target.id)).toEqual(target)
    expect(harness.observeSession).not.toHaveBeenCalled()
  })

  it.each(['this-session', 'new-session'] as const)('revalidates a changed %s binding before adopting a missing Session', async (originalDelivery) => {
    const harness = await createHarness([...inject, 'sessionController'], true)
    const target: SchedulerTask = {
      ...input,
      delivery: originalDelivery,
      sessionId: originalDelivery === 'this-session' ? sessionId : undefined,
      id: 'changed-binding-task',
      enabled: true,
      status: 'active',
      nextRunAt: schedule.at,
      createdAt: '2029-01-01T00:00:00.000Z',
      updatedAt: '2029-01-01T00:00:00.000Z',
    }
    state.set('tasks', { version: 2, tasks: [target] })
    const before = await task.get(target.id)
    await expect(task.update(target.id, { delivery: 'this-session', sessionId: 'missing-new-binding' })).resolves.toMatchObject({ ok: false, code: 'session_not_found' })
    expect(harness.observeSession).toHaveBeenCalledWith('missing-new-binding', { projectionMode: 'none' })
    expect(await task.get(target.id)).toEqual(before)
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
  })

  it('maps an actual cold inspect failure while recovering a pending identity without a receipt or second admission', async () => {
    const harness = await createHarness([...inject, 'sessionController'], true, true)
    const target: SchedulerTask = {
      ...input,
      id: 'pending-platform-task',
      enabled: true,
      status: 'active',
      nextRunAt: schedule.at,
      createdAt: '2029-01-01T00:00:00.000Z',
      updatedAt: '2029-01-01T00:00:00.000Z',
    }
    state.set('tasks', { version: 2, tasks: [target] })
    const pending: PendingDelivery = {
      task: target,
      trigger: 'schedule',
      scheduledAt: schedule.at,
      deliveredAt: schedule.at,
      message: llmModule.createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'schedule', form: 'notice', summary: input.name } }),
    }
    await history.prepare(pending)
    await expect(delivery.run(target, 'schedule', schedule.at)).resolves.toEqual({ ok: false, error: '目标会话不存在', code: 'session_not_found' })
    expect(await history.pending(target.id)).toEqual([pending])
    expect(await history.query({ taskId: target.id, limit: 10 })).toMatchObject({ ok: true, records: [] })
    expect(await task.get(target.id)).toEqual(target)
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
    expect(harness.sessions.flush).not.toHaveBeenCalled()
  })
})
