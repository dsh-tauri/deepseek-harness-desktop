import type { TaskInput } from '../types'
import {
  deleteHistory,
  deleteTasks,
  getHistory,
  getOptions,
  getTasks,
  postRunsRecover,
  postTasks,
  postTasksRun,
  postTasksToggle,
  putTasks,
} from '../apis'
import { store } from '../store'

export async function loadScheduler(withOptions = false): Promise<void> {
  const token = store.scheduler.loadToken + 1
  store.scheduler.$patch({ loadToken: token, loading: true, error: '' })
  try {
    const [tasks, runs] = await Promise.all([getTasks(), getHistory()])
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ tasks: tasks.tasks, runs: runs.runs, loading: false, refreshedAt: Date.now() })
    store.scheduler.seedReadAt()
    if (!withOptions)
      return
    const options = await getOptions()
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ options })
  }
  catch (error) {
    if (token !== store.scheduler.loadToken)
      return
    store.scheduler.$patch({ loading: false, error: messageOf(error) })
  }
}

export async function recoverScheduler(): Promise<{ ok: boolean, error?: string }> {
  try {
    await postRunsRecover()
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  await loadScheduler(true)
  return { ok: true }
}

export async function createTask(input: TaskInput): Promise<{ ok: boolean, error?: string }> {
  const schedule = input.schedule.kind === 'weekly' ? { ...input.schedule, weekdays: [...input.schedule.weekdays] } : input.schedule
  const result = await postTasks({ ...input, schedule })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function updateTask(id: string, input: TaskInput): Promise<{ ok: boolean, error?: string }> {
  const schedule = input.schedule.kind === 'weekly' ? { ...input.schedule, weekdays: [...input.schedule.weekdays] } : input.schedule
  const result = await putTasks({ id, ...input, schedule })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function toggleTask(id: string, enabled: boolean): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksToggle({ id, enabled })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function deleteTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await deleteTasks({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function runTask(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await postTasksRun({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

export async function deleteRun(id: string): Promise<{ ok: boolean, error?: string }> {
  const result = await deleteHistory({ id })
  if (!result.ok)
    return { ok: false, error: result.error }
  await loadScheduler()
  return { ok: true }
}

// --- internal ---

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
