import type { HostContext, OperationResult, SchedulerTask } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { filter, isEmpty, isNil, take } from 'lodash-es'
import { server } from '../server'
import { nextOccurrence } from '../utils/schedule'
import { isTaskDue, selectWaitingTaskIds } from '../utils/waiting'
import { executor } from './executor'
import { task } from './task'

const SCHEDULER_MAX_CONCURRENT_RUNS = 4

const running = new Set<string>()

export const scheduler = defineService({
  start(tickMs: number): () => void {
    const timer = setInterval(() => {
      void scheduler.tick().catch((error: unknown) => warn('tick failed', error))
    }, tickMs)
    return () => clearInterval(timer)
  },

  async trigger(id: string): Promise<OperationResult> {
    if (running.has(id))
      return { ok: false, error: '任务正在执行中' }
    const target = await task.get(id)
    if (target === null)
      return { ok: false, error: '任务不存在' }
    void fire(target, 'manual').catch((error: unknown) => warn('manual run failed', error))
    return { ok: true }
  },

  async tick(): Promise<void> {
    const all = await task.list()
    if (isEmpty(all))
      return
    const now = Date.now()
    for (const item of filter(all, item => item.enabled && isNil(item.nextRunAt))) {
      const occurrence = nextOccurrence(item.schedule, now)
      if (occurrence !== undefined)
        await task.advance(item.id, item.lastRunAt, new Date(occurrence).toISOString())
    }
    const pending = filter(all, item => isTaskDue(item, now) && !running.has(item.id))
    for (const item of take(pending, SCHEDULER_MAX_CONCURRENT_RUNS - running.size))
      void fire(item, 'schedule')
  },

  async waitingIds(): Promise<Set<string>> {
    const all = await task.list()
    return selectWaitingTaskIds(all, running, SCHEDULER_MAX_CONCURRENT_RUNS - running.size, Date.now())
  },
})

// --- internal ---

async function fire(target: SchedulerTask, trigger: 'schedule' | 'manual'): Promise<void> {
  if (running.has(target.id))
    return
  running.add(target.id)
  const lastRunAt = new Date().toISOString()
  try {
    await executor.run(target, trigger)
  }
  finally {
    running.delete(target.id)
    const now = Date.now()
    const previous = target.nextRunAt ? new Date(target.nextRunAt).getTime() : now
    const from = target.schedule.kind === 'interval' || target.schedule.kind === 'custom' ? previous : now
    const next = nextOccurrence(target.schedule, from)
    await task.advance(target.id, lastRunAt, next === undefined ? undefined : new Date(next).toISOString())
  }
}

function warn(message: string, error: unknown): void {
  try {
    getServerContext<HostContext>(server).logger?.warn?.(`dsh-tauri-scheduler: ${message}`, error)
  }
  catch {
  }
}
