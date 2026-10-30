import type { TaskView } from '../types'

export function activeSessionTasks(tasks: readonly TaskView[], sessionId: string | undefined): readonly TaskView[] {
  if (!sessionId)
    return []
  return tasks.filter(task => task.delivery === 'this-session' && task.sessionId === sessionId
    && task.status === 'active' && task.enabled)
}

export function isTaskOverdue(task: TaskView, now: number): boolean {
  return task.nextRunAt !== undefined && Date.parse(task.nextRunAt) <= now
}

export function orderSessionTasks(tasks: readonly TaskView[], now: number): readonly TaskView[] {
  const deadline = (task: TaskView) => {
    const at = task.nextRunAt === undefined ? Number.NaN : Date.parse(task.nextRunAt)
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
  }
  return [...tasks].sort((left, right) => {
    const overdue = Number(isTaskOverdue(right, now)) - Number(isTaskOverdue(left, now))
    if (overdue !== 0)
      return overdue
    const leftAt = deadline(left)
    const rightAt = deadline(right)
    return leftAt === rightAt ? 0 : leftAt < rightAt ? -1 : 1
  })
}
