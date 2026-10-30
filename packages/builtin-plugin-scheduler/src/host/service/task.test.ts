import type { HostContext, SchedulerTask, TaskInput } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inject } from '../../index'
import { resetWriteQueue, runtime } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { task } from './task'

vi.mock('../storage', () => ({ storage: { getItem: vi.fn(), setItem: vi.fn() } }))

const current: SchedulerTask = {
  id: 'task-1',
  delivery: 'new-session',
  status: 'active',
  name: 'existing',
  prompt: 'run it',
  schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00', timeZone: 'UTC' },
  enabled: false,
  permission: 'read-only',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nextRunAt: '2026-02-06T16:00:00.000Z',
  module: 'legacy-module',
  agentPreset: 'custom-preset',
}

const input: TaskInput = {
  delivery: 'new-session',
  name: 'new task',
  prompt: 'remind me',
  schedule: { kind: 'daily', time: '10:00', timeZone: 'UTC' },
}

const state = new Map<string, unknown>()
const disposers: Array<() => void> = []
let host: ReturnType<typeof installHost>

function installHost() {
  const inspect = vi.fn(async (id: string) => ({ meta: { id }, events: [] }))
  const resolveAgent = vi.fn()
  const currentInitiator = vi.fn<() => { session: { id: string } } | undefined>()
  const workspaceRegistry = { archivedSessionIds: [] as string[] }
  const context = {
    agents: { currentInitiator },
    sessionController: { inspect, resolveAgent },
    workspaceRegistry,
    webServer: { register: () => () => {} },
    logger: { error: vi.fn() },
  }
  disposers.push(server(context as unknown as HostContext))
  return { inspect, resolveAgent, currentInitiator, workspaceRegistry, context }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetWriteQueue()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
  state.clear()
  state.set('tasks', { version: 2, tasks: [structuredClone(current)] })
  vi.mocked(storage.getItem).mockImplementation(async key => structuredClone(state.get(key) ?? null) as never)
  vi.mocked(storage.setItem).mockImplementation(async (key, value) => {
    state.set(key, typeof value === 'string' ? JSON.parse(value) : structuredClone(value))
  })
  host = installHost()
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  resetWriteQueue()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('unified task storage and update', () => {
  it('reads legacy records as new-session active without losing protocol fields', async () => {
    const { delivery: _delivery, status: _status, ...legacy } = current
    state.set('tasks', { version: 1, tasks: [legacy] })
    expect(await task.get(current.id)).toEqual(current)
    expect(host.resolveAgent).not.toHaveBeenCalled()
  })

  it('keeps omissions, legacy fields, and an unchanged durable occurrence', async () => {
    const patch = { name: undefined, permission: undefined, schedule: structuredClone(current.schedule) }
    const result = await task.update(current.id, patch)
    expect(result).toMatchObject({ ok: true, task: { name: current.name, permission: current.permission, nextRunAt: current.nextRunAt, module: 'legacy-module', agentPreset: 'custom-preset' } })
    expect(patch).toEqual({ name: undefined, permission: undefined, schedule: current.schedule })
    expect(await task.get(current.id)).toMatchObject({ nextRunAt: current.nextRunAt, module: 'legacy-module' })
  })

  it('recomputes a changed calendar schedule in its own timezone', async () => {
    const result = await task.update(current.id, { schedule: { kind: 'weekly', weekdays: ['MO'], time: '16:00', timeZone: 'UTC' } })
    expect(result).toMatchObject({ ok: true, task: { nextRunAt: '2026-01-05T16:00:00.000Z' } })
  })

  it('serializes partial updates without losing either patch', async () => {
    const results = await Promise.all([
      task.update(current.id, { name: 'renamed' }),
      task.update(current.id, { prompt: 'new prompt' }),
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(await task.get(current.id)).toMatchObject({ name: 'renamed', prompt: 'new prompt' })
  })

  it('rejects a stale complete expected record but ignores derived waiting', async () => {
    expect(await task.update(current.id, { name: 'renamed' }, { ...current, waiting: true })).toMatchObject({ ok: true })
    expect(await task.update(current.id, { prompt: 'stale edit' }, current)).toMatchObject({ ok: false, code: 'task_conflict' })
    expect(await task.get(current.id)).toMatchObject({ name: 'renamed', prompt: current.prompt })
  })

  it('does not treat a partial expected record as a complete snapshot', async () => {
    expect(await task.update(current.id, { name: 'wrong' }, { id: current.id } as SchedulerTask)).toMatchObject({ ok: false, code: 'task_conflict' })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('blocks claimed live-run edits and toggles but still permits explicit deletion', async () => {
    runtime.running.add(current.id)
    expect(await task.update(current.id, { name: 'changed' }, current)).toMatchObject({ ok: false, code: 'task_busy' })
    expect(await task.update(current.id, { prompt: 'changed' })).toMatchObject({ ok: false, code: 'task_busy' })
    expect(await task.toggle(current.id, true)).toMatchObject({ ok: false, code: 'task_busy' })
    expect(await task.get(current.id)).toEqual(current)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(await task.remove(current.id)).toEqual({ ok: true })
    expect(await task.complete(current, '2026-01-02T00:00:00.000Z')).toBe(false)
    expect(await task.get(current.id)).toBeNull()
  })

  it('distinguishes reversible pause from terminal inactivity', async () => {
    expect(await task.toggle(current.id, true)).toMatchObject({ ok: true, task: { status: 'active', enabled: true } })
    expect(await task.toggle(current.id, false)).toMatchObject({ ok: true, task: { status: 'active', enabled: false } })
    state.set('tasks', { version: 2, tasks: [{ ...current, status: 'inactive' }] })
    expect(await task.toggle(current.id, true)).toMatchObject({ ok: false, code: 'task_inactive' })
    expect(await task.update(current.id, { prompt: 'restart' })).toMatchObject({ ok: false, code: 'task_inactive' })
  })

  it('completion and legacy target initialization never resurrect deleted records', async () => {
    expect(await task.remove(current.id)).toEqual({ ok: true })
    expect(await task.complete(current, '2026-01-02T00:00:00.000Z', '2026-01-09T16:00:00.000Z')).toBe(false)
    await task.ensureTarget({ ...current, nextRunAt: undefined })
    expect(await task.list()).toEqual([])
  })

  it('does not advance an edited task from an older run snapshot', async () => {
    await task.update(current.id, { schedule: { kind: 'daily', time: '12:00', timeZone: 'UTC' } })
    expect(await task.complete(current, '2026-01-02T01:00:00.000Z', '2026-02-13T16:00:00.000Z')).toBe(false)
    expect(await task.get(current.id)).toMatchObject({ nextRunAt: '2026-01-02T12:00:00.000Z', schedule: { kind: 'daily' } })
  })

  it('manual completion does not consume the next scheduled occurrence', async () => {
    expect(await task.complete(current, '2026-01-02T00:00:00.000Z', undefined, false)).toBe(true)
    expect(await task.get(current.id)).toMatchObject({ status: 'active', nextRunAt: current.nextRunAt, lastRunAt: '2026-01-02T00:00:00.000Z' })
  })

  it('scheduled one-shot completion ends the record but retains it for history', async () => {
    expect(await task.complete(current, '2026-01-02T00:00:00.000Z')).toBe(true)
    expect(await task.get(current.id)).toMatchObject({ status: 'inactive', enabled: false })
  })

  it.each([null, false, 0, '', [], { name: 'ok', prompt: 'ok', schedule: { kind: 'hourly', minute: 1 } }])('rejects invalid or implicit-delivery creation %j', async (value) => {
    expect(await task.create(value as never)).toMatchObject({ ok: false, code: 'task_invalid' })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('does not replace an explicitly null required field', async () => {
    expect(await task.update(current.id, { name: null } as never)).toMatchObject({ ok: false, error: '任务名称不能为空', code: 'task_invalid' })
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('this-session binding and resource authority', () => {
  it('captures the owning public initiator and validates cold without activation', async () => {
    host.currentInitiator.mockReturnValue({ session: { id: 'owner' } })
    const pending = task.create({ ...input, delivery: 'this-session' })
    host.currentInitiator.mockReturnValue({ session: { id: 'different' } })
    expect(await pending).toMatchObject({ ok: true, task: { delivery: 'this-session', status: 'active', sessionId: 'owner' } })
    expect(host.inspect).toHaveBeenCalledWith('owner')
    expect(host.resolveAgent).not.toHaveBeenCalled()
  })

  it('rejects an explicit target different from the true initiator', async () => {
    host.currentInitiator.mockReturnValue({ session: { id: 'owner' } })
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'other' })).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(host.inspect).not.toHaveBeenCalled()
  })

  it('fails closed when no binding or public authority is available', async () => {
    expect(await task.create({ ...input, delivery: 'this-session' })).toMatchObject({ ok: false, code: 'session_unavailable' })
    delete (host.context as Partial<typeof host.context>).sessionController
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'owner' })).toMatchObject({ ok: false, code: 'session_unavailable' })
  })

  it('declares the session controller required by the host inject guard', () => {
    expect(inject).toContain('sessionController')
  })

  it('rejects the core cold-session absence class without hiding read failures', async () => {
    class ApiSessionNotFound extends Error {}
    const loader = {
      import: vi.fn<() => Promise<unknown>>(async () => ({ ApiSessionNotFound })),
      unwrapExports: vi.fn((value: unknown) => value),
    }
    Object.assign(host.context, { loader })
    host.inspect.mockRejectedValueOnce(new ApiSessionNotFound('missing'))
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'missing' })).toEqual({ ok: false, error: '目标会话不存在', code: 'session_not_found' })
    expect(loader.import).toHaveBeenCalledWith('@deepseek-ai/dsh-api-session-controller')
    loader.import.mockResolvedValueOnce({ default: { ApiSessionNotFound } })
    loader.unwrapExports.mockReturnValueOnce({ ApiSessionNotFound })
    host.inspect.mockRejectedValueOnce(new ApiSessionNotFound('missing wrapped export'))
    expect(await task.validateTarget({ ...current, permission: undefined, delivery: 'this-session', sessionId: 'missing' })).toEqual({ ok: false, error: '目标会话不存在', code: 'session_not_found' })
    host.inspect.mockRejectedValueOnce(new Error('disk read failed'))
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'owner' })).toEqual({ ok: false, error: '宿主无法读取目标会话', code: 'session_unavailable' })
    loader.import.mockRejectedValueOnce(new Error('module unavailable'))
    host.inspect.mockRejectedValueOnce(new ApiSessionNotFound('missing'))
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'missing' })).toEqual({ ok: false, error: '宿主无法读取目标会话', code: 'session_unavailable' })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(host.resolveAgent).not.toHaveBeenCalled()
  })

  it('rejects archived, missing, and delegated session targets without activation', async () => {
    host.workspaceRegistry.archivedSessionIds.push('archived')
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'archived' })).toMatchObject({ ok: false, code: 'session_archived' })
    host.inspect.mockRejectedValueOnce({ code: 'session/not-found' })
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'missing' })).toMatchObject({ ok: false, code: 'session_not_found' })
    host.inspect.mockResolvedValueOnce({ meta: { id: 'child', origin: 'subagent', delegationDepth: 1 }, events: [] } as never)
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'child' })).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(host.resolveAgent).not.toHaveBeenCalled()
  })

  it.each(['workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'] as const)('rejects this-session override %s', async (field) => {
    expect(await task.create({ ...input, delivery: 'this-session', sessionId: 'owner', [field]: 'override' })).toMatchObject({ ok: false, code: 'task_invalid' })
    expect(host.inspect).not.toHaveBeenCalled()
  })

  it('retains per-task resources for new-session and forbids a bound id', async () => {
    const resources = { workspaceId: 'ws', permission: 'read-only', provider: 'provider', model: 'model', reasoningEffort: 'high' }
    expect(await task.create({ ...input, ...resources })).toMatchObject({ ok: true, task: resources })
    expect(await task.create({ ...input, sessionId: 'owner' })).toMatchObject({ ok: false, code: 'task_invalid' })
  })

  it('switches modes only after explicitly clearing incompatible overrides', async () => {
    expect(await task.update(current.id, { delivery: 'this-session', sessionId: 'owner' })).toMatchObject({ ok: false, code: 'task_invalid' })
    const result = await task.update(current.id, { delivery: 'this-session', sessionId: 'owner', permission: '' })
    expect(result).toMatchObject({ ok: true, task: { delivery: 'this-session', sessionId: 'owner', nextRunAt: current.nextRunAt } })
    if (!result.ok)
      throw new Error(result.error)
    expect(result.task).not.toHaveProperty('permission')
    expect(await task.update(current.id, { delivery: 'new-session' })).toMatchObject({ ok: true, task: { delivery: 'new-session' } })
    expect(await task.get(current.id)).not.toHaveProperty('sessionId')
  })

  it('session stop terminates only matching bound tasks and preserves records', async () => {
    state.set('tasks', { version: 2, tasks: [current, { ...current, id: 'bound', delivery: 'this-session', sessionId: 'owner', permission: undefined }] })
    await task.stopSession('owner')
    expect(await task.get('bound')).toMatchObject({ status: 'inactive', enabled: false })
    expect(await task.get(current.id)).toEqual(current)
    expect(await task.toggle('bound', true)).toMatchObject({ ok: false, code: 'task_inactive' })
  })
})
