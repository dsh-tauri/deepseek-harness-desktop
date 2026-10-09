import type { TaskInput } from '../types'
import { afterEach, expect, it, vi } from 'vitest'
import { postTasks, putTasks } from '../apis'
import { createTask, updateTask } from './scheduler'

vi.mock('../apis', () => ({
  postTasks: vi.fn(),
  putTasks: vi.fn(),
  getTasks: vi.fn(async () => ({ tasks: [] })),
  getHistory: vi.fn(async () => ({ runs: [] })),
}))
vi.mock('../store', () => ({
  store: { scheduler: { loadToken: 0, $patch: vi.fn(), seedReadAt: vi.fn() } },
}))

afterEach(() => {
  vi.clearAllMocks()
})

it('serializes readonly weekly weekdays for create and update without mutating the form', async () => {
  const weekdays = Object.freeze(['MO', 'FR'] as const)
  const input: TaskInput = { name: 'Weekly', prompt: 'run', schedule: { kind: 'weekly', weekdays, time: '09:00' } }
  vi.mocked(postTasks).mockResolvedValue({ ok: true })
  vi.mocked(putTasks).mockResolvedValue({ ok: true })
  expect(await createTask(input)).toEqual({ ok: true })
  expect(await updateTask('task', input)).toEqual({ ok: true })
  expect(postTasks).toHaveBeenCalledExactlyOnceWith(input)
  expect(putTasks).toHaveBeenCalledExactlyOnceWith({ id: 'task', ...input })
  expect(vi.mocked(postTasks).mock.calls[0]![0].schedule).not.toBe(input.schedule)
  expect(vi.mocked(putTasks).mock.calls[0]![0].schedule).not.toBe(input.schedule)
  expect(input.schedule).toEqual({ kind: 'weekly', weekdays: ['MO', 'FR'], time: '09:00' })
})
