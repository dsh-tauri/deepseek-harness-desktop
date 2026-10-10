import type { TaskView } from '../types'
import { store } from '../store'
import { deleteTask } from './scheduler'

export function requestTaskDeletion(task: TaskView): void {
  store.deletion.request(task)
}

export function cancelTaskDeletion(): void {
  store.deletion.cancel()
}

export function dismissDeletionFeedback(seq?: number): void {
  store.deletion.dismiss(seq)
}

export async function confirmTaskDeletion(): Promise<void> {
  const task = store.deletion.begin()
  if (task === null)
    return
  try {
    const outcome = await deleteTask(task.id)
    store.deletion.finish(task, outcome)
  }
  catch (error) {
    store.deletion.finish(task, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
