import type { HistoryPage, TaskInput, TaskView } from '../types'
import { deleteHistory, deleteTasks, getHistory, getOptions, getTasks, postRunsRecover, postTasks, postTasksRun, postTasksToggle, putTasks } from '../apis'
import { store } from '../store'

export async function loadScheduler(withOptions = false): Promise<void> {
  const token = store.scheduler.loadToken + 1
  store.scheduler.$patch({ loadToken: token, loading: true, error: '' })
  try {
    const [tasks, history] = await Promise.all([getTasks(), getHistory({ limit: 100 })])
    if (token !== store.scheduler.loadToken)
      return
    if (!history.ok)
      throw new Error(history.error)
    store.scheduler.$patch({ tasks: tasks.tasks, runs: history.runs, loading: false, refreshedAt: Date.now(), successfulReadToken: token })
    store.scheduler.seedReadAt()
    if (withOptions)
      await loadOptions()
  }
  catch (error) {
    if (token === store.scheduler.loadToken)
      store.scheduler.$patch({ loading: false, error: messageOf(error) })
  }
}

export async function loadOptions(): Promise<void> {
  store.scheduler.$patch({ options: await getOptions() })
}

export async function loadTaskHistory(taskId: string, limit: number, before?: string): Promise<HistoryPage> {
  const result = await getHistory({ taskId, limit, before }, { ignoreResponseError: true })
  if (!result.ok)
    throw Object.assign(new Error(result.error), { code: result.code })
  return result
}

export async function recoverScheduler(): Promise<{ ok: boolean, error?: string }> {
  try {
    const result = await postRunsRecover()
    if ('ok' in result && !result.ok)
      return { ok: false, error: 'error' in result ? String(result.error) : 'Recovery failed' }
    await loadScheduler(true)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function createTask(input: TaskInput): Promise<{ ok: boolean, error?: string, task?: TaskView }> {
  try {
    const schedule = input.schedule.kind === 'weekly' ? { ...input.schedule, weekdays: [...input.schedule.weekdays] } : input.schedule
    const result = await postTasks({ ...input, schedule })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true, task: result.task }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function updateTask(id: string, input: TaskInput, expected: TaskView): Promise<{ ok: boolean, error?: string, task?: TaskView }> {
  try {
    const schedule = input.schedule.kind === 'weekly' ? { ...input.schedule, weekdays: [...input.schedule.weekdays] } : input.schedule
    const expectedSchedule = expected.schedule.kind === 'weekly' ? { ...expected.schedule, weekdays: [...expected.schedule.weekdays] } : expected.schedule
    const result = await putTasks({ id, ...input, schedule, expected: { ...expected, schedule: expectedSchedule } })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true, task: result.task }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function toggleTask(id: string, enabled: boolean): Promise<{ ok: boolean, error?: string }> {
  try {
    const result = await postTasksToggle({ id, enabled })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function deleteTask(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const result = await deleteTasks({ id })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function runTask(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const result = await postTasksRun({ id })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function deleteRun(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const result = await deleteHistory({ id })
    if (!result.ok)
      return { ok: false, error: result.error }
    await loadScheduler()
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
