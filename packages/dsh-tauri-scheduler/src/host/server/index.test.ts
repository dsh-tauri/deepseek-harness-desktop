import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SessionEventLike } from '../service/executor.utils'
import type { HistoryPage, OperationResult, SchedulerTask } from '../types'
import type { SetupAgentLike } from '../utils/agent-runtime.types'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '.'
import { resetWriteQueue, runtime } from '../config/runtime'
import { history } from '../service/history'
import { scheduler } from '../service/scheduler'
import { task } from '../service/task'
import { storage } from '../storage'
import { createTaskTool } from '../tools/create-task'
import { deleteTaskTool } from '../tools/delete-task'
import { listTasksTool } from '../tools/list-tasks'
import { updateTaskTool } from '../tools/update-task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const P = '/api/tauri/scheduler'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/tasks`],
  ['POST', `${P}/tasks`],
  ['PUT', `${P}/tasks`],
  ['DELETE', `${P}/tasks`],
  ['POST', `${P}/tasks/toggle`],
  ['POST', `${P}/tasks/run`],
  ['GET', `${P}/history`],
  ['DELETE', `${P}/history`],
  ['GET', `${P}/options`],
  ['POST', `${P}/runs/recover`],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [`${P}/tasks`]: 'GET, HEAD, POST, PUT, DELETE',
  [`${P}/tasks/toggle`]: 'POST',
  [`${P}/tasks/run`]: 'POST',
  [`${P}/history`]: 'GET, HEAD, DELETE',
  [`${P}/options`]: 'GET, HEAD',
  [`${P}/runs/recover`]: 'POST',
}

const UNDECLARED_METHOD = 'PATCH'

interface Harness {
  registered: Map<string, WebRoute>
  ctx: Context
  core: ReturnType<typeof createCore>
}

const finishes: Array<() => void> = []
const coreStops: Array<() => void> = []

function createCore() {
  let messageSequence = 0
  const events: Array<{ type: string, data: { inserted: UserMessage[] } }> = []
  const session = { id: 'session-1' }
  const followup = vi.fn((message: UserMessage) => {
    events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
  })
  const agent = { session, followup }
  const listeners = new Set<(session: unknown, event: SessionEventLike) => void>()
  const controls: Array<{ finish: () => void, ready: Promise<void> }> = []
  let readyRun = () => {}
  let finishAutomatically = false
  const runReady = new Promise<void>((resolve) => {
    readyRun = resolve
  })
  coreStops.push(() => {
    finishAutomatically = true
    controls.forEach(control => control.finish())
  })
  const create = vi.fn(async (input: { sessionId: string, setup: (ctx: unknown, agent: SetupAgentLike) => Promise<void> }) => {
    const createdSession = { id: input.sessionId, seq: 0 }
    let finishIdle = () => {}
    let markReady = () => {}
    const idle = new Promise<void>((resolve) => {
      finishIdle = resolve
    })
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const emit = (type: string, data: Record<string, unknown>) => {
      createdSession.seq += 1
      for (const listener of listeners)
        listener(createdSession, { type, data, seq: createdSession.seq })
    }
    const finish = () => {
      emit('turn/end', { reason: { kind: 'completed' } })
      finishIdle()
    }
    controls.push({ finish, ready })
    finishes.push(finish)
    await input.setup({}, { session: createdSession })
    return { agent: { session: createdSession, followup: vi.fn(() => {
      emit('turn/start', {})
      markReady()
      readyRun()
      if (finishAutomatically)
        finish()
    }), whenIdle: vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(idle), cancel: vi.fn(finish) } }
  })
  const workspace = { path: '/virtual/http-workspace', status: vi.fn(async () => 'ok'), attachSession: vi.fn(async () => {}) }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', { createUserMessage: (input: Omit<UserMessage, 'id' | 'role'>) => ({ ...input, id: `http-message-${++messageSequence}` as MessageId, role: 'user' as const }) }],
    ['@deepseek-ai/dsh-agent', { installModelSelection: vi.fn() }],
    ['@deepseek-ai/dsh-user-approval', { setApprovalPolicy: vi.fn() }],
  ])
  return {
    agents: { create, currentInitiator: vi.fn<() => { session: { id: string } } | undefined>(), withoutInitiator: (fn: () => Promise<unknown>) => fn() },
    sessionController: { inspect: vi.fn(async (id: string) => ({ meta: { id }, events: structuredClone(events) })), resolveAgent: vi.fn(async () => ({ agent })) },
    workspaceRegistry: { archivedSessionIds: [] as string[], get: vi.fn(() => workspace) },
    sessions: { flush: vi.fn(async () => true) },
    permissionPresets: { defaultPreset: 'read-only', set: vi.fn() },
    agentPresets: { mount: vi.fn(async () => {}) },
    get: () => undefined,
    on: vi.fn((name: string, listener: (session: unknown, event: SessionEventLike) => void) => {
      if (name === 'session/event')
        listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    loader: { import: vi.fn(async (name: string) => modules.get(name)), unwrapExports: (value: unknown) => value },
    controls,
    runReady,
    agent,
  }
}

function createHarness(): Harness {
  const registered = new Map<string, WebRoute>()
  const core = createCore()
  return {
    registered,
    core,
    ctx: {
      ...core,
      webServer: {
        register(route: WebRoute): () => void {
          const key = routeKey(route.kind, route.path)
          if (registered.has(key))
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          registered.set(key, route)
          return () => {
            registered.delete(key)
          }
        },
      },
      logger: { error: () => {} },
    } as unknown as Context,
  }
}

const servers: Server[] = []
const disposers: Array<() => void> = []
const state = new Map<string, unknown>()
const now = '2026-06-01T12:00:00.000Z'
const taskInput = { delivery: 'this-session', sessionId: 'session-1', name: 'HTTP reminder', prompt: 'real prompt', schedule: { kind: 'once', at: '2026-06-02T12:00:00.000Z', timeZone: 'UTC' } } as const

async function listen(registered: Map<string, WebRoute>): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.get(routeKey('exact', pathname))
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function sendJson(base: string, method: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function mount(harness: Harness): () => void {
  const dispose = server(harness.ctx)
  disposers.push(dispose)
  return dispose
}

beforeEach(() => {
  vi.clearAllMocks()
  resetWriteQueue()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(now))
  state.clear()
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
  })
})

afterEach(async () => {
  coreStops.splice(0).forEach(stop => stop())
  finishes.splice(0).forEach(finish => finish())
  await scheduler.stop()
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  resetWriteQueue()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('调度器路由声明', () => {
  it('声明 10 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(EXPECTED_ROUTES).toHaveLength(10)
    expect(harness.registered.size).toBe(EXPECTED_PATHS.length)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法返回 405 + allow 头（每条路径与迁移前一致）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const path of EXPECTED_PATHS) {
      const response = await fetch(`${base}${path}`, { method: UNDECLARED_METHOD })
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort(), path).toEqual(ALLOW_BY_PATH[path].split(', ').sort())
    }

    dispose()
  })

  it('oPTIONS 未声明时返回 405 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const tasks = await fetch(`${base}${P}/tasks`, { method: 'OPTIONS' })
    expect(tasks.status).toBe(405)
    expect(tasks.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD, POST, PUT, DELETE'.split(', ').sort())

    const run = await fetch(`${base}${P}/tasks/run`, { method: 'OPTIONS' })
    expect(run.status).toBe(405)
    expect(run.headers.get('allow')?.split(', ').sort()).toEqual('POST'.split(', ').sort())

    dispose()
  })

  it('缺 id 的写路由返回 400 与迁移前一致的错误文案（在任何落盘之前）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['PUT', `${P}/tasks`, '缺少任务 id'],
      ['DELETE', `${P}/tasks`, '缺少任务 id'],
      ['POST', `${P}/tasks/toggle`, '缺少任务 id'],
      ['POST', `${P}/tasks/run`, '缺少任务 id'],
      ['DELETE', `${P}/history`, '缺少执行记录 id'],
    ]
    for (const [method, path, error] of cases) {
      const response = await sendJson(base, method, path, '{}')
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error })
    }

    // id 类型不符（数字）同样按缺省处理，不被当作合法 id 放行。
    const wrongType = await sendJson(base, 'DELETE', `${P}/tasks`, JSON.stringify({ id: 42 }))
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toEqual({ error: '缺少任务 id' })

    dispose()
  })

  it('非法请求体在 create 路由返回 400（校验先于落盘）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const empty = await sendJson(base, 'POST', `${P}/tasks`, JSON.stringify({}))
    expect(empty.status).toBe(400)

    const invalidJson = await sendJson(base, 'POST', `${P}/tasks`, 'not-json')
    expect(invalidJson.status).toBe(400)

    dispose()
  })
})

describe('真实 HTTP 与 agent 工具共享协议', () => {
  it('hTTP 创建/list/update/delete 与四个工具读取同一任务来源', async () => {
    const harness = createHarness()
    mount(harness)
    const base = await listen(harness.registered)
    const createdResponse = await sendJson(base, 'POST', `${P}/tasks`, JSON.stringify(taskInput))
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json() as { ok: true, task: SchedulerTask }
    expect(created).toMatchObject({ ok: true, task: { delivery: 'this-session', status: 'active', sessionId: 'session-1' } })
    expect(await listTasksTool().execute()).toEqual({ ok: true, tasks: [created.task] })
    expect(await updateTaskTool().execute({ task_id: created.task.id, prompt: 'tool rewrite' })).toMatchObject({ ok: true, taskId: created.task.id })
    const listed = await (await fetch(`${base}${P}/tasks`)).json() as { tasks: SchedulerTask[] }
    expect(listed.tasks[0]).toMatchObject({ prompt: 'tool rewrite', nextRunAt: taskInput.schedule.at })
    const missingExpected = await sendJson(base, 'PUT', `${P}/tasks`, JSON.stringify({ id: created.task.id, name: 'unsafe' }))
    expect(missingExpected.status).toBe(400)
    expect(await missingExpected.json()).toMatchObject({ ok: false, code: 'task_expected_required' })
    const partialExpected = await sendJson(base, 'PUT', `${P}/tasks`, JSON.stringify({ id: created.task.id, name: 'unsafe', expected: { id: created.task.id } }))
    expect(partialExpected.status).toBe(400)
    expect(await partialExpected.json()).toMatchObject({ ok: false, code: 'task_conflict' })
    const stale = await sendJson(base, 'PUT', `${P}/tasks`, JSON.stringify({ id: created.task.id, name: 'unsafe', expected: created.task }))
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ ok: false, code: 'task_conflict' })
    const updated = await sendJson(base, 'PUT', `${P}/tasks`, JSON.stringify({ id: created.task.id, name: 'renamed', expected: { ...listed.tasks[0], waiting: true } }))
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ ok: true, task: { name: 'renamed', prompt: 'tool rewrite' } })
    expect(await deleteTaskTool().execute({ task_id: created.task.id })).toEqual({ ok: true })
    expect(await (await fetch(`${base}${P}/tasks`)).json()).toEqual({ tasks: [] })
    expect(harness.core.sessionController.resolveAgent).not.toHaveBeenCalled()
    expect(harness.core.agent.followup).not.toHaveBeenCalled()
  })

  it('create 工具要求明确 delivery，捕获真实 initiator 并输出可重播卡片 metadata', async () => {
    const harness = createHarness()
    mount(harness)
    harness.core.agents.currentInitiator.mockReturnValue({ session: { id: 'session-1' } })
    const tool = createTaskTool()
    expect(tool.parameters.required).toEqual(['delivery', 'name', 'prompt', 'schedule'])
    expect(tool.parameters.properties.delivery.enum).toEqual(['this-session', 'new-session'])
    const created = await tool.execute({ ...taskInput, sessionId: undefined })
    expect(created).toMatchObject({ ok: true, taskId: expect.stringMatching(/^task-/), nextRunAt: taskInput.schedule.at, task: { delivery: 'this-session', status: 'active', sessionId: 'session-1', prompt: taskInput.prompt } })
    expect(JSON.parse(tool.output.render({}, created)[0].text)).toEqual(created)
    expect(await tool.execute({ ...taskInput, delivery: undefined })).toMatchObject({ ok: false, code: 'task_invalid' })
    expect(await tool.execute({ ...taskInput, sessionId: 'other' })).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(await tool.execute({ ...taskInput, permission: 'danger-full-access' })).toMatchObject({ ok: false, code: 'task_invalid' })
    expect(await listTasksTool().execute()).toMatchObject({ ok: true, tasks: [{ id: created.taskId }] })
    expect(harness.core.sessionController.resolveAgent).not.toHaveBeenCalled()
  })

  it('history 强制 limit，混合分页支持失活/不可用 Session 且不激活来源', async () => {
    const harness = createHarness()
    mount(harness)
    const base = await listen(harness.registered)
    const response = await sendJson(base, 'POST', `${P}/tasks`, JSON.stringify(taskInput))
    const created = await response.json() as { task: SchedulerTask }
    const target = { ...created.task, status: 'inactive' as const }
    state.set('tasks', { version: 2, tasks: [target] })
    await history.saveRun({ id: 'run-a', taskId: target.id, taskName: target.name, trigger: 'schedule', status: 'succeeded', scheduledFor: '2026-06-01T09:00:00.000Z', startedAt: now, finishedAt: now })
    await history.commit({ task: target, trigger: 'schedule', scheduledAt: '2026-06-01T10:00:00.000Z', deliveredAt: now, message: { id: 'receipt-a' as MessageId, role: 'user', content: [], source: { kind: 'schedule' } } })
    await history.commit({ task: target, trigger: 'manual', scheduledAt: '2026-06-01T11:00:00.000Z', deliveredAt: now, message: { id: 'receipt-b' as MessageId, role: 'user', content: [], source: { kind: 'schedule' } } })
    harness.core.workspaceRegistry.archivedSessionIds.push('session-1')
    harness.core.sessionController.inspect.mockRejectedValue(new Error('unavailable source'))
    harness.core.sessionController.inspect.mockClear()
    for (const limit of ['', '0', '101', '1.2', '-1', 'NaN', '2&limit=3']) {
      const invalid = await fetch(`${base}${P}/history?taskId=${target.id}${limit === '' ? '' : `&limit=${limit}`}`)
      expect(invalid.status, limit).toBe(400)
      expect(await invalid.json()).toMatchObject({ ok: false, code: 'history_invalid_limit' })
    }
    const firstResponse = await fetch(`${base}${P}/history?taskId=${target.id}&limit=2`)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json() as OperationResult<HistoryPage>
    expect(first).toMatchObject({ ok: true, records: [{ id: 'receipt-b', delivery: 'this-session' }, { id: 'receipt-a', delivery: 'this-session' }], runs: [], nextBefore: 'receipt-a', retention: { days: 30, records: 200 } })
    const second = await (await fetch(`${base}${P}/history?taskId=${target.id}&limit=2&before=receipt-a`)).json()
    expect(second).toMatchObject({ ok: true, records: [{ id: 'run-a', delivery: 'new-session' }], runs: [{ id: 'run-a' }] })
    expect(second).not.toHaveProperty('nextBefore')
    const global = await (await fetch(`${base}${P}/history?limit=10`)).json()
    expect(global).toMatchObject({ ok: true, runs: [{ id: 'run-a' }] })
    const invalidCursor = await fetch(`${base}${P}/history?taskId=${target.id}&limit=10&before=not-present`)
    expect(invalidCursor.status).toBe(400)
    expect(await invalidCursor.json()).toMatchObject({ ok: false, code: 'delivery_cursor_not_found' })
    const deleted = await sendJson(base, 'DELETE', `${P}/history`, JSON.stringify({ id: 'receipt-a' }))
    expect(deleted.status).toBe(200)
    expect(await (await fetch(`${base}${P}/history?taskId=${target.id}&limit=10`)).json()).toMatchObject({ ok: true, earlierRecordsPruned: true, records: [{ id: 'receipt-b' }, { id: 'run-a' }] })
    expect(harness.core.sessionController.inspect).not.toHaveBeenCalled()
    expect(harness.core.sessionController.resolveAgent).not.toHaveBeenCalled()
    expect(harness.core.agent.followup).not.toHaveBeenCalled()
  })

  it.each(['once', 'interval'] as const)('重复 HTTP recover 不消费 active %s run，完成后才更新 task/journal', async (kind) => {
    const harness = createHarness()
    mount(harness)
    const base = await listen(harness.registered)
    const dueAt = '2026-06-01T11:02:17.000Z'
    const target: SchedulerTask = {
      id: 'live-task',
      name: 'live',
      delivery: 'new-session',
      status: 'active',
      enabled: true,
      prompt: 'active prompt',
      workspaceId: 'http-workspace',
      createdAt: now,
      updatedAt: now,
      nextRunAt: dueAt,
      schedule: kind === 'once' ? { kind, at: dueAt, timeZone: 'UTC' } : { kind, everyMinutes: 15, anchor: dueAt, timeZone: 'UTC' },
    }
    state.set('tasks', { version: 2, tasks: [target] })
    await scheduler.tick()
    await harness.core.runReady
    expect(harness.core.controls).toHaveLength(1)
    const originalJournal = await history.journals(target.id)
    const originalRuns = await history.listRuns(target.id)
    expect(originalRuns).toMatchObject([{ status: 'running' }])
    expect(originalJournal).toMatchObject([{ task: target }])
    expect(originalJournal[0]).not.toHaveProperty('completedAt')
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(new Date('2026-06-01T13:02:17.000Z'))
      const response = await sendJson(base, 'POST', `${P}/runs/recover`, '{}')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      await scheduler.tick()
      expect(await task.get(target.id)).toEqual(target)
      expect(await history.listRuns(target.id)).toEqual(originalRuns)
      expect(await history.journals(target.id)).toEqual(originalJournal)
      expect(harness.core.agents.create).toHaveBeenCalledTimes(1)
    }
    const accepted = [...runtime.accepted]
    expect(accepted).toHaveLength(1)
    harness.core.controls[0]!.finish()
    await Promise.all(accepted)
    expect(await history.journals()).toEqual([])
    expect(await history.listRuns(target.id)).toMatchObject([{ status: 'succeeded', finishedAt: '2026-06-01T13:02:17.000Z' }])
    expect(await task.get(target.id)).toMatchObject(kind === 'once' ? { status: 'inactive' } : { status: 'active', nextRunAt: '2026-06-01T13:17:17.000Z' })
    await scheduler.tick()
    expect(harness.core.agents.create).toHaveBeenCalledTimes(1)
  })

  it.each(['once', 'interval'] as const)('active %s run 拒绝 rename/pause 工具或 HTTP 编辑且不重跑同 occurrence', async (kind) => {
    const harness = createHarness()
    mount(harness)
    const base = await listen(harness.registered)
    const dueAt = '2026-06-01T11:02:17.000Z'
    const target: SchedulerTask = {
      id: 'live-task',
      name: 'live',
      delivery: 'new-session',
      status: 'active',
      enabled: true,
      prompt: 'active prompt',
      workspaceId: 'http-workspace',
      createdAt: now,
      updatedAt: now,
      nextRunAt: dueAt,
      schedule: kind === 'once' ? { kind, at: dueAt, timeZone: 'UTC' } : { kind, everyMinutes: 15, anchor: dueAt, timeZone: 'UTC' },
    }
    state.set('tasks', { version: 2, tasks: [target] })
    await scheduler.tick()
    await harness.core.runReady
    const renamed = await sendJson(base, 'PUT', `${P}/tasks`, JSON.stringify({ id: target.id, expected: target, name: 'changed' }))
    expect(renamed.status).toBe(400)
    expect(await renamed.json()).toMatchObject({ ok: false, code: 'task_busy' })
    const paused = await sendJson(base, 'POST', `${P}/tasks/toggle`, JSON.stringify({ id: target.id, enabled: false }))
    expect(paused.status).toBe(400)
    expect(await paused.json()).toMatchObject({ ok: false, code: 'task_busy' })
    expect(await updateTaskTool().execute({ task_id: target.id, name: 'changed by tool' })).toMatchObject({ ok: false, code: 'task_busy' })
    expect(await task.get(target.id)).toEqual(target)
    vi.setSystemTime(new Date('2026-06-01T13:02:17.000Z'))
    const accepted = [...runtime.accepted]
    harness.core.controls[0]!.finish()
    await Promise.all(accepted)
    await scheduler.tick()
    expect(harness.core.agents.create).toHaveBeenCalledTimes(1)
    expect(await history.journals()).toEqual([])
    expect(await task.get(target.id)).toMatchObject(kind === 'once' ? { name: 'live', status: 'inactive' } : { name: 'live', nextRunAt: '2026-06-01T13:17:17.000Z' })
  })

  it('run/toggle 返回终态领域错误，非法 enabled 不会变成暂停', async () => {
    const harness = createHarness()
    mount(harness)
    const base = await listen(harness.registered)
    const created = await (await sendJson(base, 'POST', `${P}/tasks`, JSON.stringify(taskInput))).json() as { task: SchedulerTask }
    const invalid = await sendJson(base, 'POST', `${P}/tasks/toggle`, JSON.stringify({ id: created.task.id, enabled: 'yes' }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'task_invalid' })
    state.set('tasks', { version: 2, tasks: [{ ...created.task, status: 'inactive' }] })
    for (const path of ['run', 'toggle']) {
      const response = await sendJson(base, 'POST', `${P}/tasks/${path}`, JSON.stringify({ id: created.task.id, enabled: true }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ ok: false, code: 'task_inactive' })
    }
    expect(harness.core.sessionController.resolveAgent).not.toHaveBeenCalled()
  })
})
