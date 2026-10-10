import type { TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { HostContext, SchedulerRun, SchedulerTask } from '../types'
import type { SetupAgentLike } from '../utils/agent-runtime.types'
import type { SessionEventLike } from './executor.utils'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { resetWriteQueue } from '../config/runtime'
import { registerSessionOrigin } from '../events/session-origin'
import { server } from '../server'
import { executor } from './executor'
import { runs } from './runs'
import { scheduler } from './scheduler'

const localRequire = createRequire(import.meta.url)
const platformRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-api-session-controller'))
const { SessionProjectionRegistry } = platformRequire('@deepseek-ai/dsh-session-projection')
const schemaModule = platformRequire('zod')

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: vi.fn(),
}))

vi.mock('./runs', () => ({
  runs: { save: vi.fn(), load: vi.fn() },
}))

const taskFixture: SchedulerTask = {
  id: 'task-1',
  delivery: 'new-session',
  status: 'active',
  name: 'nightly',
  schedule: { kind: 'interval', everyMinutes: 30, timeZone: 'UTC' },
  prompt: 'run the nightly job',
  workspaceId: 'ws-1',
  enabled: true,
  createdAt: '2025-12-31T00:00:00.000Z',
  updatedAt: '2025-12-31T00:00:00.000Z',
}

const disposers: Array<() => void> = []
const contexts: Context[] = []
const records = new Map<string, SchedulerRun>()

interface AgentInput {
  sessionId: string
  meta: { cwd: string, agentPreset: string }
  agentOptions: { provider?: string, model?: string }
  setup: (agentCtx: unknown, createdAgent?: SetupAgentLike) => Promise<void>
}

interface RunControl {
  session: { id: string, seq: number, snapshotEvents: () => readonly SessionEventLike[] }
  agentContext: object
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  converge: (reason?: Record<string, unknown>) => void
  failConvergence: (error: unknown) => void
}

function installHost(nativeSessions?: SessionStore) {
  const controls: RunControl[] = []
  const listeners = new Set<(target: unknown, event: SessionEventLike) => void>()
  const stopWatch = vi.fn()
  const flush = vi.fn<(session: unknown) => Promise<boolean>>(async () => true)
  const mount = vi.fn<(agentCtx: unknown, preset: string) => Promise<void>>(async () => {})
  const rename = vi.fn()
  const permissions = { defaultPreset: 'read-only', set: vi.fn() }
  const defaultSelection = { provider: 'default-provider', model: 'default-model', reasoningEffort: 'medium' }
  const workspace = { path: '/tmp/ws', status: vi.fn(async () => 'ok'), attachSession: vi.fn(async () => {}) }
  const getWorkspace = vi.fn((id: string) => id === 'ws-1' ? workspace : undefined)
  const runtime = {
    createUserMessage: vi.fn<(input: Parameters<typeof createUserMessage>[0]) => unknown>(input => ({ runtime: 'host', input })),
    installModelSelection: vi.fn<(agentCtx: unknown, selection: unknown) => () => void>(() => () => {}),
    setApprovalPolicy: vi.fn(),
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', { installModelSelection: runtime.installModelSelection, default: {} }],
    ['@deepseek-ai/dsh-llm', { createUserMessage: runtime.createUserMessage, default: {} }],
    ['@deepseek-ai/dsh-user-approval', { setApprovalPolicy: runtime.setApprovalPolicy, default: {} }],
  ])
  const loader = {
    import: vi.fn(async (name: string) => modules.get(name)),
    unwrapExports: vi.fn((value: unknown) => (value as { default?: unknown })?.default),
  }
  const create = vi.fn(async (input: AgentInput) => {
    const events: SessionEventLike[] = []
    const nativeSession = nativeSessions?.create(SessionId(input.sessionId), { meta: input.meta })
    const memorySession = { id: input.sessionId, seq: 0, snapshotEvents: vi.fn(() => events) }
    const session = nativeSession ?? memorySession
    const agentContext = Object.defineProperty({}, 'agent', {
      get(): never {
        throw new Error('cannot get property "agent" without inject')
      },
    })
    let releaseIdle: () => void = () => {}
    let rejectIdle: (error: unknown) => void = () => {}
    const idle = new Promise<void>((resolve, reject) => {
      releaseIdle = resolve
      rejectIdle = reject
    })
    const emit = (event: SessionEventLike) => {
      events.push(event)
      for (const listener of listeners) listener(session, event)
    }
    const followup = vi.fn((message: UserMessage) => {
      if (nativeSession) {
        emit(nativeSession.append('turn/start', { turn: 0 }))
        emit(nativeSession.append('user/message', message, { surfaceOp: 'append' }))
        return
      }
      memorySession.seq += 1
      emit({ seq: memorySession.seq, type: 'turn/start', data: {} })
    })
    const cancel = vi.fn()
    controls.push({
      session: session as RunControl['session'],
      agentContext,
      followup,
      cancel,
      converge: (reason = { kind: 'completed' }) => {
        if (nativeSession) {
          emit(nativeSession.append('turn/end', { turn: 0, reason: reason as TurnEndReason }))
        }
        else {
          memorySession.seq += 1
          emit({ seq: memorySession.seq, type: 'turn/end', data: { reason } })
        }
        releaseIdle()
      },
      failConvergence: rejectIdle,
    })
    await input.setup(agentContext, { session })
    return { agent: { session, followup, cancel, whenIdle: vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(idle) } }
  })
  const withoutInitiator = vi.fn(async (fn: () => Promise<unknown>) => fn())
  const host = {
    loader,
    workspaceRegistry: { get: getWorkspace },
    sessions: { flush },
    agents: { create, withoutInitiator },
    agentPresets: { mount },
    permissionPresets: permissions,
    get: (name: string) => name === 'agentDefaultModel'
      ? { currentSelection: () => defaultSelection }
      : name === 'sessionTitle' ? { rename } : undefined,
    on: vi.fn((_name: string, listener: (target: unknown, event: SessionEventLike) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        stopWatch()
      }
    }),
  }
  disposers.push(server({ ...host, webServer: { register: () => () => {} } } as unknown as HostContext))
  return { controls, create, withoutInitiator, flush, mount, rename, permissions, defaultSelection, workspace, getWorkspace, loader, runtime, stopWatch }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  records.clear()
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined)
  vi.mocked(runs.save).mockReset().mockImplementation(async (run) => {
    records.set(run.id, structuredClone(run))
  })
  vi.mocked(runs.load).mockReset().mockImplementation(async (id) => {
    const run = records.get(id)
    return run ? structuredClone(run) : null
  })
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  for (const context of contexts.splice(0))
    await context.fiber.dispose()
  resetWriteQueue()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('executor.run', () => {
  it.each(['schedule', 'manual'] as const)('keeps %s execution origin in native session projections after replay and outside run history', async (trigger) => {
    const context = new Context()
    contexts.push(context)
    const sessions = new SessionStore(context)
    const projections = new SessionProjectionRegistry(context)
    const stopOrigin = await registerSessionOrigin({
      loader: { import: async () => schemaModule },
      sessionProjections: projections,
    })
    const host = installHost(sessions)
    host.runtime.createUserMessage.mockImplementation(createUserMessage)
    const pending = executor.run(taskFixture, trigger, '2025-12-31T23:30:00.000Z')
    await vi.advanceTimersByTimeAsync(0)
    const control = host.controls[0]!
    control.converge()
    await expect(pending).resolves.toMatchObject({ ok: true, sessionId: control.session.id })

    const session = sessions.get(SessionId(control.session.id))!
    expect(session.header.origin).toBeUndefined()
    expect(projections.snapshot(session).values).toMatchObject({ 'dsh-tauri-scheduler.origin': true })
    const events = session.snapshotEvents()
    const checkpoint = projections.checkpoint(session)
    records.clear()
    expect(projections.viewCheckpoint(checkpoint)).toMatchObject({ 'dsh-tauri-scheduler.origin': true })
    expect(projections.restore({}, events, SessionLogOffset(0), session.header, SessionLogOffset(0)).snapshot.values).toMatchObject({ 'dsh-tauri-scheduler.origin': true })

    const reminder = sessions.create(SessionId(`reminder-${trigger}`))
    reminder.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'this-session reminder' }], source: { kind: 'schedule' } }), { surfaceOp: 'append' })
    expect(projections.snapshot(reminder).values).toMatchObject({ 'dsh-tauri-scheduler.origin': false })
    const fork = sessions.create(SessionId(`fork-${trigger}`), { seed: events, inheritedEventCount: SessionLogOffset(events.length), meta: { parentSession: session.id, isSeeded: true } })
    expect(projections.snapshot(fork).values).toMatchObject({ 'dsh-tauri-scheduler.origin': false })
    stopOrigin()
    expect(projections.snapshot(session).values).not.toHaveProperty('dsh-tauri-scheduler.origin')
  })

  it('registers origin before starting the scheduler and owns late optional capability lifecycle', async () => {
    const context = new Context()
    contexts.push(context)
    const register = vi.fn(() => vi.fn())
    const start = vi.spyOn(scheduler, 'start').mockImplementation(() => {
      expect(register).toHaveBeenCalledTimes(1)
      return async () => {}
    })
    context.accessor('loader', { get: () => ({ import: vi.fn(async () => schemaModule) }) })
    await context.plugin({ name: 'origin-host', apply(ctx) {
      ctx.provide('tools', { register: vi.fn() })
      ctx.provide('webServer', { register: () => () => {} })
      ctx.provide('sessionProjections', { register })
    } })
    const mounted = await context.plugin({ name: 'scheduler-origin', inject: ['tools', 'webServer'], apply })
    expect(start).toHaveBeenCalledTimes(1)
    await mounted.dispose()
    expect(register.mock.results[0]!.value).toHaveBeenCalledTimes(1)

    const late = new Context()
    contexts.push(late)
    const stopOrigin = vi.fn()
    const registerLate = vi.fn(() => stopOrigin)
    const stopRuntime = vi.fn(async () => {})
    start.mockImplementation(() => stopRuntime)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    late.accessor('loader', { get: () => ({ import: vi.fn(async () => schemaModule) }) })
    await late.plugin({ name: 'late-origin-host', apply(ctx) {
      ctx.provide('tools', { register: vi.fn() })
      ctx.provide('webServer', { register: () => () => {} })
    } })
    const waiting = await late.plugin({ name: 'scheduler-late-origin', inject: ['tools', 'webServer'], apply })
    expect(console.warn).toHaveBeenCalledWith('[scheduler origin] Public session projection unavailable; source marks disabled until declared.')
    expect(start).toHaveBeenCalledTimes(2)
    const provider = await late.plugin({ name: 'late-projections', apply(ctx) {
      ctx.provide('sessionProjections', { register: registerLate })
    } })
    await vi.advanceTimersByTimeAsync(0)
    expect(registerLate).toHaveBeenCalledTimes(1)
    await provider.dispose()
    expect(stopOrigin).toHaveBeenCalledTimes(1)
    expect(stopRuntime).not.toHaveBeenCalled()
    await waiting.dispose()
    expect(stopRuntime).toHaveBeenCalledTimes(1)
  })

  it('fails safe when native origin projection registration is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const register = vi.fn()
    const dispose = await registerSessionOrigin({ loader: { import: vi.fn(async () => {
      throw new Error('schema unavailable')
    }) }, sessionProjections: { register } })
    expect(register).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[scheduler origin] Public session projection unavailable; source marks disabled.', expect.objectContaining({ message: 'schema unavailable' }))
    expect(() => dispose()).not.toThrow()
  })

  it('定时运行保存实际到期时间，startedAt 使用启动时间', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'schedule', '2025-12-31T23:30:00.000Z')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: true })

    expect(runs.save).toHaveBeenNthCalledWith(1, expect.objectContaining({
      trigger: 'schedule',
      scheduledFor: '2025-12-31T23:30:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    }), taskFixture)
    expect(host.runtime.createUserMessage).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'run the nightly job' }],
      source: { kind: 'scheduler', taskId: 'task-1', runId: expect.stringMatching(/^run-/), scheduledFor: '2025-12-31T23:30:00.000Z' },
    })
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ scheduledFor: '2025-12-31T23:30:00.000Z', status: 'succeeded' }))
  })

  it('定时运行未显式传到期时间时使用任务 nextRunAt', async () => {
    const host = installHost()
    const pending = executor.run({ ...taskFixture, nextRunAt: '2025-12-31T23:00:00.000Z' }, 'schedule')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await pending

    expect(runs.save).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scheduledFor: '2025-12-31T23:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    }), { ...taskFixture, nextRunAt: '2025-12-31T23:00:00.000Z' })
  })

  it('手动运行的到期时间始终取当前时间', async () => {
    const host = installHost()
    const pending = executor.run({ ...taskFixture, nextRunAt: '2025-12-31T23:00:00.000Z' }, 'manual', '2025-12-31T23:30:00.000Z')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await pending

    expect(runs.save).toHaveBeenNthCalledWith(1, expect.objectContaining({
      trigger: 'manual',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    }), { ...taskFixture, nextRunAt: '2025-12-31T23:00:00.000Z' })
    expect(host.runtime.createUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ scheduledFor: '2026-01-01T00:00:00.000Z' }),
    }))
  })

  it('新会话保存并发送运行开始时的 prompt，不受任务后续更新影响', async () => {
    const host = installHost()
    const target = { ...taskFixture }
    const pending = executor.run(target, 'manual')
    target.prompt = 'edited after launch'
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await pending

    expect(runs.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: 'run the nightly job' }), taskFixture)
    expect(host.runtime.createUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'run the nightly job' }],
    }))
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'run the nightly job' }))
  })

  it('新会话使用宿主 runtime 和 scoped Agent 装配独立模型、权限及 preset', async () => {
    const host = installHost()
    const pending = executor.run({
      ...taskFixture,
      provider: 'task-provider',
      model: 'task-model',
      reasoningEffort: 'high',
      permission: 'workspace-write',
      agentPreset: ' custom ',
    }, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    const control = host.controls[0]!
    control.converge()
    await expect(pending).resolves.toMatchObject({ ok: true, sessionId: control.session.id, model: 'task-model' })

    expect(host.loader.import.mock.calls).toEqual([
      ['@deepseek-ai/dsh-agent'],
      ['@deepseek-ai/dsh-llm'],
      ['@deepseek-ai/dsh-user-approval'],
    ])
    expect(host.loader.unwrapExports).not.toHaveBeenCalled()
    expect(host.withoutInitiator).toHaveBeenCalledTimes(1)
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: control.session.id,
      meta: { cwd: '/tmp/ws', agentPreset: 'custom' },
      agentOptions: { provider: 'task-provider', model: 'task-model' },
    }))
    expect(host.mount).toHaveBeenCalledTimes(1)
    expect(host.mount.mock.calls[0]![0]).toBe(control.agentContext)
    expect(host.mount.mock.calls[0]![1]).toBe('custom')
    expect(host.runtime.installModelSelection).toHaveBeenCalledTimes(1)
    expect(host.runtime.installModelSelection.mock.calls[0]![0]).toBe(control.agentContext)
    expect(host.runtime.installModelSelection.mock.calls[0]![1]).toEqual({
      current: { provider: 'task-provider', model: 'task-model', reasoningEffort: 'high' },
      assembled: undefined,
    })
    expect(host.permissions.set).toHaveBeenCalledWith(control.session, 'workspace-write')
    expect(host.runtime.setApprovalPolicy).toHaveBeenCalledWith(control.session, 'never')
    expect(host.workspace.attachSession).toHaveBeenCalledWith(control.session.id)
    expect(host.rename).toHaveBeenCalledWith(control.session, 'nightly')
    expect(control.followup.mock.calls[0]![0]).toBe(host.runtime.createUserMessage.mock.results[0]!.value)
  })

  it('未指定资源时使用宿主默认模型、权限与 standard preset', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    const control = host.controls[0]!
    control.converge()
    await pending

    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: '/tmp/ws', agentPreset: 'standard' },
      agentOptions: { provider: 'default-provider', model: 'default-model' },
    }))
    expect(host.runtime.installModelSelection.mock.calls[0]![0]).toBe(control.agentContext)
    expect(host.runtime.installModelSelection.mock.calls[0]![1]).toEqual({
      current: { provider: 'default-provider', model: 'default-model', reasoningEffort: 'medium' },
      assembled: undefined,
    })
    expect(host.permissions.set).toHaveBeenCalledWith(control.session, 'read-only')
    expect(host.runtime.setApprovalPolicy).toHaveBeenCalledWith(control.session, 'never')
  })

  it('并行运行的 run、session、资源设置与收尾状态互不污染', async () => {
    const host = installHost()
    const secondWorkspace = { ...host.workspace, path: '/tmp/second', attachSession: vi.fn(async () => {}) }
    host.getWorkspace.mockImplementation(id => id === 'ws-2' ? secondWorkspace : host.workspace)
    const first = executor.run({ ...taskFixture, permission: 'read-only', provider: 'p-1', model: 'm-1', reasoningEffort: 'low' }, 'schedule')
    const second = executor.run({ ...taskFixture, id: 'task-2', workspaceId: 'ws-2', permission: 'danger-full-access', provider: 'p-2', model: 'm-2', reasoningEffort: 'high' }, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.controls).toHaveLength(2)
    const [one, two] = host.controls as [RunControl, RunControl]
    expect(one.session.id).not.toBe(two.session.id)
    expect(records.size).toBe(2)
    expect(new Set([...records.values()].map(run => run.id)).size).toBe(2)
    expect(host.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ meta: { cwd: '/tmp/ws', agentPreset: 'standard' }, agentOptions: { provider: 'p-1', model: 'm-1' } }))
    expect(host.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ meta: { cwd: '/tmp/second', agentPreset: 'standard' }, agentOptions: { provider: 'p-2', model: 'm-2' } }))
    expect(host.runtime.installModelSelection.mock.calls[0]![0]).toBe(one.agentContext)
    expect(host.runtime.installModelSelection.mock.calls[0]![1]).toEqual({ current: { provider: 'p-1', model: 'm-1', reasoningEffort: 'low' }, assembled: undefined })
    expect(host.runtime.installModelSelection.mock.calls[1]![0]).toBe(two.agentContext)
    expect(host.runtime.installModelSelection.mock.calls[1]![1]).toEqual({ current: { provider: 'p-2', model: 'm-2', reasoningEffort: 'high' }, assembled: undefined })
    expect(host.permissions.set.mock.calls).toEqual([[one.session, 'read-only'], [two.session, 'danger-full-access']])

    two.converge()
    await expect(second).resolves.toMatchObject({ ok: true, sessionId: two.session.id, model: 'm-2' })
    expect([...records.values()].find(run => run.taskId === 'task-1')).toMatchObject({ status: 'running' })
    one.converge({ kind: 'error', error: { code: 'first_failed', message: 'first failed' } })
    await expect(first).resolves.toMatchObject({ ok: false, sessionId: one.session.id, error: 'first failed' })
    expect([...records.values()].find(run => run.taskId === 'task-1')).toMatchObject({ status: 'failed', error: 'first failed' })
    expect([...records.values()].find(run => run.taskId === 'task-2')).toMatchObject({ status: 'succeeded', error: undefined })
    expect(host.stopWatch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('未绑定工作区的新会话使用隔离的 automations 目录', async () => {
    vi.stubEnv('DSH_HOME', 'C:/isolated-scheduler')
    const host = installHost()
    const pending = executor.run({ ...taskFixture, workspaceId: undefined }, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: true })

    expect(mkdir).toHaveBeenCalledWith('C:/isolated-scheduler/automations', { recursive: true })
    expect(host.getWorkspace).not.toHaveBeenCalled()
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: 'C:/isolated-scheduler/automations', agentPreset: 'standard' } }))
  })

  it('目标工作区不存在时失败落盘，不创建 Agent', async () => {
    const host = installHost()
    host.getWorkspace.mockReturnValueOnce(undefined)
    await expect(executor.run(taskFixture, 'manual')).resolves.toMatchObject({ ok: false, error: '目标工作区已不存在。' })

    expect(host.create).not.toHaveBeenCalled()
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '目标工作区已不存在。' }))
  })

  it('首次运行记录无法落盘时拒绝执行，不加载 runtime 或创建 Agent', async () => {
    const host = installHost()
    vi.mocked(runs.save).mockRejectedValueOnce(new Error('initial run write failed'))
    await expect(executor.run(taskFixture, 'manual')).rejects.toThrow('initial run write failed')

    expect(records.size).toBe(0)
    expect(host.loader.import).not.toHaveBeenCalled()
    expect(host.create).not.toHaveBeenCalled()
  })

  it('会话日志保存返回 false 时 completed 也判失败，不写成功记录', async () => {
    const host = installHost()
    host.flush.mockResolvedValueOnce(false)
    const pending = executor.run(taskFixture, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: false, error: '定时任务会话日志保存失败。' })

    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '定时任务会话日志保存失败。' }))
    expect(runs.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }))
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('会话日志保存拒绝时记录具体错误并释放运行资源', async () => {
    const host = installHost()
    host.flush.mockRejectedValueOnce(new Error('session flush unavailable'))
    const pending = executor.run(taskFixture, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'session flush unavailable' })

    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: 'session flush unavailable' }))
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('成功终态无法落盘时返回失败，并记录持久化错误', async () => {
    const host = installHost()
    vi.mocked(runs.save).mockImplementation(async (run) => {
      if (run.status === 'succeeded')
        throw new Error('settlement write failed')
      records.set(run.id, structuredClone(run))
    })
    const pending = executor.run(taskFixture, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'settlement write failed' })

    expect([...records.values()]).toEqual([expect.objectContaining({ status: 'failed', error: 'settlement write failed' })])
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('所有终态写入都失败时拒绝，保留 running 记录供崩溃恢复', async () => {
    const host = installHost()
    vi.mocked(runs.save).mockImplementation(async (run) => {
      if (run.status !== 'running')
        throw new Error('run history unavailable')
      records.set(run.id, structuredClone(run))
    })
    const pending = executor.run(taskFixture, 'manual')
    const rejected = expect(pending).rejects.toThrow('run history unavailable')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await rejected

    expect([...records.values()]).toEqual([expect.objectContaining({ status: 'running' })])
    expect(runs.save).toHaveBeenCalledTimes(3)
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('运行超时取消 Agent，宽限期内收敛后仍按 timeout 失败落盘', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'schedule')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    const control = host.controls[0]!
    expect(control.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'scheduler run timeout' })
    expect(host.flush).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    control.converge()
    await expect(pending).resolves.toMatchObject({ ok: false, sessionId: control.session.id, error: '定时任务超过最大运行时限。' })

    expect(host.flush).toHaveBeenCalledWith(control.session)
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '定时任务超过最大运行时限。' }))
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消后 Agent 永不收敛时在 10 秒宽限期后失败，不冲刷日志', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'schedule')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(host.controls[0]!.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'scheduler run timeout' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9999)
    expect([...records.values()]).toEqual([expect.objectContaining({ status: 'running' })])
    expect(host.flush).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ ok: false, error: '定时任务取消后未能在安全时限内停止。' })

    expect(host.flush).not.toHaveBeenCalled()
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '定时任务取消后未能在安全时限内停止。' }))
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消后的收敛 Promise 拒绝时失败，不冲刷日志且清理宽限 timer', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'schedule')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    host.controls[0]!.failConvergence(new Error('cancel did not converge'))
    await expect(pending).resolves.toMatchObject({ ok: false, error: '定时任务取消后未能在安全时限内停止。' })

    expect(host.flush).not.toHaveBeenCalled()
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '定时任务取消后未能在安全时限内停止。' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正常执行结束后释放 deadline timer 与事件订阅，不再取消 Agent', async () => {
    const host = installHost()
    const pending = executor.run(taskFixture, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    host.controls[0]!.converge()
    await expect(pending).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 10_000)

    expect(host.controls[0]!.cancel).not.toHaveBeenCalled()
    expect(host.flush).toHaveBeenCalledTimes(1)
    expect(host.stopWatch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('插件卸载抛 INACTIVE_EFFECT 时记为 cancelled，不当作执行失败', async () => {
    const host = installHost()
    host.loader.import.mockRejectedValueOnce(Object.assign(new Error('inactive effect'), { code: 'INACTIVE_EFFECT' }))
    await expect(executor.run(taskFixture, 'schedule')).resolves.toMatchObject({ ok: false, error: '定时任务因插件卸载被取消。' })

    expect(host.create).not.toHaveBeenCalled()
    expect(runs.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled', error: '定时任务因插件卸载被取消。' }))
  })
})
