import type { HistoryPage, TaskInput, TaskView } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteHistory, deleteTasks, getHistory, getOptions, getTasks, postRunsRecover, postTasks, postTasksRun, postTasksToggle, putTasks } from '../apis'
import { store } from '../store'
import { createTask, deleteRun, deleteTask, loadOptions, loadScheduler, loadTaskHistory, recoverScheduler, runTask, toggleTask, updateTask } from './scheduler'

vi.mock('dsh-tauri/client', async () => await import('../../../../dsh-tauri/src/client/modules/valtio-define'))
vi.mock('../apis', () => ({
  deleteHistory: vi.fn(),
  deleteTasks: vi.fn(),
  getHistory: vi.fn(),
  getOptions: vi.fn(),
  getTasks: vi.fn(),
  postRunsRecover: vi.fn(),
  postTasks: vi.fn(),
  postTasksRun: vi.fn(),
  postTasksToggle: vi.fn(),
  putTasks: vi.fn(),
}))

const task = {
  id: 'task-a',
  name: 'Weekly',
  prompt: 'Original instruction',
  delivery: 'new-session',
  status: 'active',
  schedule: { kind: 'weekly', weekdays: ['MO', 'FR'], time: '09:00', timeZone: 'Asia/Shanghai' },
  enabled: true,
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
} satisfies TaskView
const page: HistoryPage = {
  records: [],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
  retention: { days: 30, records: 200 },
}
const options: Awaited<ReturnType<typeof getOptions>> = {
  workspaces: [],
  permissions: [],
  models: [],
  failures: [],
  defaultPermission: 'read-only',
  defaultModel: null,
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  store.scheduler.$patch({ tasks: [], runs: [], loading: false, error: '', refreshedAt: 0, loadToken: 0, successfulReadToken: 0, readAt: 0, readIds: [], options })
  vi.mocked(getTasks).mockResolvedValue({ tasks: [task] })
  vi.mocked(getHistory).mockResolvedValue({ ok: true, ...page, runs: [] })
  vi.mocked(getOptions).mockResolvedValue(options)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scheduler catalog reads', () => {
  it('requests an explicit history limit and commits the successful post-request read token', async () => {
    await loadScheduler(true)
    expect(getTasks).toHaveBeenCalledExactlyOnceWith()
    expect(getHistory).toHaveBeenCalledExactlyOnceWith({ limit: 100 })
    expect(getOptions).toHaveBeenCalledExactlyOnceWith()
    expect(store.scheduler.tasks).toEqual([task])
    expect(store.scheduler.$state).toMatchObject({ loading: false, error: '', loadToken: 1, successfulReadToken: 1 })
    expect(store.scheduler.readAt).toBeGreaterThan(0)
  })

  it('does not let an older task response overwrite a newer catalog or successful read token', async () => {
    const first = deferred<Awaited<ReturnType<typeof getTasks>>>()
    vi.mocked(getTasks).mockReturnValueOnce(first.promise)
    const pending = loadScheduler(true)
    await loadScheduler()
    first.resolve({ tasks: [{ ...task, name: 'Stale name' }] })
    await pending
    expect(store.scheduler.tasks).toEqual([task])
    expect(store.scheduler.$state).toMatchObject({ loadToken: 2, successfulReadToken: 2, loading: false })
    expect(getOptions).not.toHaveBeenCalled()
  })

  it('does not accept a failed or stale read as evidence that an existing task is deleted', async () => {
    await loadScheduler()
    vi.mocked(getHistory).mockResolvedValueOnce({ ok: false, error: 'History read failed', code: 'history_failed' })
    await loadScheduler()
    expect(store.scheduler.tasks).toEqual([task])
    expect(store.scheduler.$state).toMatchObject({ loadToken: 2, successfulReadToken: 1, loading: false, error: 'History read failed' })
  })

  it('ignores a failed older request after a newer request has succeeded', async () => {
    const first = deferred<Awaited<ReturnType<typeof getHistory>>>()
    vi.mocked(getHistory).mockReturnValueOnce(first.promise)
    const pending = loadScheduler()
    await loadScheduler()
    first.resolve({ ok: false, error: 'Stale failure' })
    await pending
    expect(store.scheduler.$state).toMatchObject({ tasks: [task], successfulReadToken: 2, loading: false, error: '' })
  })

  it('reports transport failure without clearing the last catalog', async () => {
    await loadScheduler()
    vi.mocked(getTasks).mockRejectedValueOnce(new Error('Connection lost'))
    await loadScheduler()
    expect(store.scheduler.$state).toMatchObject({ tasks: [task], successfulReadToken: 1, loading: false, error: 'Connection lost' })
  })

  it('loads resource options without requesting task or history data', async () => {
    await loadOptions()
    expect(getOptions).toHaveBeenCalledExactlyOnceWith()
    expect(getTasks).not.toHaveBeenCalled()
    expect(getHistory).not.toHaveBeenCalled()
    expect(store.scheduler.options).toEqual(options)
  })
})

describe('task-specific delivery history', () => {
  it('passes task identity, explicit page limit and exclusive cursor unchanged', async () => {
    const result = await loadTaskHistory('task-a', 20, 'message-z')
    expect(getHistory).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-a', limit: 20, before: 'message-z' }, { ignoreResponseError: true })
    expect(result).toEqual({ ok: true, ...page, runs: [] })
    expect(store.scheduler.loadToken).toBe(0)
  })

  it('preserves the official cursor failure code for the history component to recover', async () => {
    vi.mocked(getHistory).mockResolvedValueOnce({ ok: false, error: 'Cursor expired', code: 'delivery_cursor_not_found' })
    await expect(loadTaskHistory('task-a', 20, 'expired')).rejects.toMatchObject({ message: 'Cursor expired', code: 'delivery_cursor_not_found' })
  })
})

describe('scheduler mutations', () => {
  it('serializes readonly weekly weekdays without changing the input or the expected record', async () => {
    const weekdays = Object.freeze(['MO', 'FR'] as const)
    const input: TaskInput = { delivery: 'new-session', name: 'Weekly', prompt: 'Updated instruction', schedule: { kind: 'weekly', weekdays, time: '09:00', timeZone: 'Asia/Shanghai' } }
    vi.mocked(postTasks).mockResolvedValueOnce({ ok: true, task })
    vi.mocked(putTasks).mockResolvedValueOnce({ ok: true, task })
    expect(await createTask(input)).toEqual({ ok: true, task })
    expect(await updateTask('task-a', input, task)).toEqual({ ok: true, task })
    expect(postTasks).toHaveBeenCalledExactlyOnceWith(input)
    expect(putTasks).toHaveBeenCalledExactlyOnceWith({ id: 'task-a', ...input, expected: task })
    expect(vi.mocked(postTasks).mock.calls[0]![0].schedule).not.toBe(input.schedule)
    expect(vi.mocked(putTasks).mock.calls[0]![0].schedule).not.toBe(input.schedule)
    expect(input.schedule).toEqual({ kind: 'weekly', weekdays: ['MO', 'FR'], time: '09:00', timeZone: 'Asia/Shanghai' })
    expect(task.prompt).toBe('Original instruction')
  })

  it('keeps an optimistic-concurrency rejection as a visible error and does not refresh away the draft', async () => {
    const input: TaskInput = { delivery: 'new-session', name: 'Weekly', prompt: 'My draft', schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } }
    vi.mocked(putTasks).mockResolvedValueOnce({ ok: false, error: 'Task changed', code: 'task_conflict' })
    expect(await updateTask('task-a', input, task)).toEqual({ ok: false, error: 'Task changed' })
    expect(getTasks).not.toHaveBeenCalled()
    expect(input.prompt).toBe('My draft')
    expect(vi.mocked(putTasks).mock.calls[0]![0].expected).toEqual(task)
  })

  it('returns create transport failures instead of rejecting the form save', async () => {
    vi.mocked(postTasks).mockRejectedValueOnce(new Error('Offline'))
    const input: TaskInput = { delivery: 'this-session', sessionId: 'owner', name: 'Reminder', prompt: 'Report', schedule: { kind: 'hourly', minute: 15 } }
    expect(await createTask(input)).toEqual({ ok: false, error: 'Offline' })
    expect(getTasks).not.toHaveBeenCalled()
  })

  it.each([
    { api: postTasksToggle, action: () => toggleTask('task-a', false), body: { id: 'task-a', enabled: false } },
    { api: deleteTasks, action: () => deleteTask('task-a'), body: { id: 'task-a' } },
    { api: postTasksRun, action: () => runTask('task-a'), body: { id: 'task-a' } },
    { api: deleteHistory, action: () => deleteRun('run-a'), body: { id: 'run-a' } },
  ])('refreshes the shared catalog only after the mutation succeeds %#', async ({ api, action, body }) => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true })
    expect(await action()).toEqual({ ok: true })
    expect(api).toHaveBeenCalledExactlyOnceWith(body)
    expect(getTasks).toHaveBeenCalledExactlyOnceWith()
    expect(getHistory).toHaveBeenCalledExactlyOnceWith({ limit: 100 })
  })

  it.each([
    { api: postTasksToggle, action: () => toggleTask('task-a', true) },
    { api: deleteTasks, action: () => deleteTask('task-a') },
    { api: postTasksRun, action: () => runTask('task-a') },
    { api: deleteHistory, action: () => deleteRun('run-a') },
  ])('does not refresh after a rejected or unreachable mutation %#', async ({ api, action }) => {
    vi.mocked(api).mockResolvedValueOnce({ ok: false, error: 'Rejected' })
    expect(await action()).toEqual({ ok: false, error: 'Rejected' })
    vi.mocked(api).mockRejectedValueOnce(new Error('Network error'))
    expect(await action()).toEqual({ ok: false, error: 'Network error' })
    expect(getTasks).not.toHaveBeenCalled()
  })

  it('refreshes task, history and resource options after crash recovery', async () => {
    vi.mocked(postRunsRecover).mockResolvedValueOnce({ ok: true })
    expect(await recoverScheduler()).toEqual({ ok: true })
    expect(postRunsRecover).toHaveBeenCalledExactlyOnceWith()
    expect(getTasks).toHaveBeenCalledExactlyOnceWith()
    expect(getOptions).toHaveBeenCalledExactlyOnceWith()
  })

  it('reports a rejected recovery without requesting task data', async () => {
    vi.mocked(postRunsRecover).mockResolvedValueOnce({ ok: false, error: 'Recovery refused' })
    expect(await recoverScheduler()).toEqual({ ok: false, error: 'Recovery refused' })
    expect(getTasks).not.toHaveBeenCalled()
  })
})
