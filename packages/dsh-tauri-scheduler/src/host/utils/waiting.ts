import type { SchedulerTask } from '../types'
import { isNil } from 'lodash-es'

export function isTaskDue(item: Pick<SchedulerTask, 'delivery' | 'status' | 'enabled' | 'nextRunAt'>, now: number): boolean {
  return item.delivery === 'new-session' && item.status === 'active' && item.enabled
    && Number.isFinite(now) && !isNil(item.nextRunAt) && new Date(item.nextRunAt).getTime() <= now
}

export function selectWaitingTaskIds(
  items: readonly SchedulerTask[],
  runningIds: ReadonlySet<string>,
  capacity: number,
  now: number,
): Set<string> {
  const pending = items.filter(item => isTaskDue(item, now) && !runningIds.has(item.id))
  return new Set(pending.slice(Math.max(0, capacity)).map(item => item.id))
}
