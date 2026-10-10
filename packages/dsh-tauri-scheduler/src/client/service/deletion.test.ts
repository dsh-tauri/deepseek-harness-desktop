import type { TaskView } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { cancelTaskDeletion, confirmTaskDeletion, dismissDeletionFeedback, requestTaskDeletion } from './deletion'
import { deleteTask } from './scheduler'

vi.mock('dsh-tauri/client', async () => await import('../../../../dsh-tauri/src/client/modules/valtio-define'))
vi.mock('./scheduler', () => ({ deleteTask: vi.fn() }))

function task(id: string): TaskView {
  return {
    id,
    name: `Task ${id}`,
    prompt: 'Report',
    delivery: 'this-session',
    status: 'active',
    sessionId: 'owner',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
  }
}

beforeEach(() => {
  store.deletion.$patch({ pendingTask: null, deletingTaskId: null, feedback: null, feedbackSeq: 0 })
  vi.mocked(deleteTask).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('global deletion lifecycle', () => {
  it('does not delete until confirmed and cancellation clears only the pending task', async () => {
    requestTaskDeletion(task('a'))
    expect(store.deletion.pendingTask?.id).toBe('a')
    expect(deleteTask).not.toHaveBeenCalled()
    cancelTaskDeletion()
    expect(store.deletion.pendingTask).toBeNull()
    await confirmTaskDeletion()
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('serializes confirmation, prevents replacement while busy, and preserves final feedback globally', async () => {
    let resolve!: (value: { ok: boolean }) => void
    vi.mocked(deleteTask).mockReturnValueOnce(new Promise(done => resolve = done))
    requestTaskDeletion(task('a'))
    const confirmation = confirmTaskDeletion()
    expect(store.deletion.deletingTaskId).toBe('a')
    cancelTaskDeletion()
    requestTaskDeletion(task('b'))
    await confirmTaskDeletion()
    expect(store.deletion.pendingTask?.id).toBe('a')
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith('a')
    resolve({ ok: true })
    await confirmation
    expect(store.deletion.pendingTask).toBeNull()
    expect(store.deletion.deletingTaskId).toBeNull()
    expect(store.deletion.feedback).toEqual({ seq: 1, kind: 'deleted', taskId: 'a', name: 'Task a' })
    requestTaskDeletion(task('b'))
    cancelTaskDeletion()
    expect(store.deletion.feedback?.taskId).toBe('a')
  })

  it.each([
    { outcome: { ok: false, error: 'server refused' }, expected: 'server refused' },
    { outcome: new Error('network broke'), expected: 'network broke' },
    { outcome: 'transport failure', expected: 'transport failure' },
  ])('settles API failures and thrown values as global feedback %#', async ({ outcome, expected }) => {
    if (typeof outcome === 'object' && !(outcome instanceof Error))
      vi.mocked(deleteTask).mockResolvedValueOnce(outcome)
    else
      vi.mocked(deleteTask).mockRejectedValueOnce(outcome)
    requestTaskDeletion(task('a'))
    await expect(confirmTaskDeletion()).resolves.toBeUndefined()
    expect(store.deletion.deletingTaskId).toBeNull()
    expect(store.deletion.pendingTask).toBeNull()
    expect(store.deletion.feedback).toEqual({ seq: 1, kind: 'deleteFailed', taskId: 'a', name: 'Task a', error: expected })
  })

  it('does not let an old banner dismissal clear a newer deletion result', async () => {
    vi.mocked(deleteTask).mockResolvedValue({ ok: true })
    requestTaskDeletion(task('a'))
    await confirmTaskDeletion()
    requestTaskDeletion(task('b'))
    await confirmTaskDeletion()
    dismissDeletionFeedback(1)
    expect(store.deletion.feedback).toEqual({ seq: 2, kind: 'deleted', taskId: 'b', name: 'Task b' })
    dismissDeletionFeedback(2)
    expect(store.deletion.feedback).toBeNull()
  })

  it('ignores an out-of-order store completion not owned by the in-flight request', () => {
    requestTaskDeletion(task('a'))
    store.deletion.begin()
    store.deletion.finish(task('b'), { ok: true })
    expect(store.deletion.deletingTaskId).toBe('a')
    expect(store.deletion.feedback).toBeNull()
    store.deletion.finish(task('a'), { ok: false })
    expect(store.deletion.feedback).toEqual({ seq: 1, kind: 'deleteFailed', taskId: 'a', name: 'Task a' })
  })
})
