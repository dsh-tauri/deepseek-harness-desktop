import type { HostContext, OperationResult, RunTrigger, SchedulerTask } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { drainRuntime, runtime, trackAccepted, withTaskQueue } from '../config/runtime'
import { server } from '../server'
import { nextFutureOccurrence } from '../utils/occurrence'
import { latestDueOccurrence } from '../utils/schedule'
import { selectWaitingTaskIds } from '../utils/waiting'
import { delivery } from './delivery'
import { executor } from './executor'
import { history } from './history'
import { recovery } from './recovery'
import { task } from './task'

const SCHEDULER_MAX_CONCURRENT_RUNS = 4

export const scheduler = defineService({
  start(tickMs: number): () => Promise<void> {
    runtime.stopping = false
    const ctx = getServerContext<HostContext>(server)
    const stopActivity = ctx.on?.('workspace/session-activity', sessionActivity)
    const stopSession = ctx.on?.('workspace/session-stop', sessionStop)
    let tickInFlight = true
    void trackAccepted(background(async () => {
      await recovery.recover()
      if (!runtime.stopping)
        await scheduler.tick()
    })).catch((error: unknown) => warn('recover interrupted runs failed', error)).finally(() => {
      tickInFlight = false
    })
    const timer = setInterval(() => {
      if (runtime.stopping || tickInFlight)
        return
      tickInFlight = true
      void trackAccepted(background(() => scheduler.tick())).catch((error: unknown) => warn('tick failed', error)).finally(() => {
        tickInFlight = false
      })
    }, tickMs)
    return async () => {
      runtime.stopping = true
      clearInterval(timer)
      stopActivity?.()
      stopSession?.()
      await drainRuntime()
    }
  },

  async trigger(id: string): Promise<OperationResult> {
    return withTaskQueue(async () => {
      if (runtime.stopping)
        return { ok: false, error: '调度器正在卸载', code: 'scheduler_stopping' }
      if (runtime.running.has(id))
        return { ok: false, error: '任务正在执行中', code: 'task_busy' }
      await repairOccurrences(id)
      const target = await task.get(id)
      if (target === null)
        return { ok: false, error: '任务不存在', code: 'task_not_found' }
      if (target.status === 'inactive')
        return { ok: false, error: '任务已结束，不能重新启用或运行', code: 'task_inactive' }
      if (target.delivery === 'new-session' && runtime.running.size >= SCHEDULER_MAX_CONCURRENT_RUNS)
        return { ok: false, error: '调度器运行并发已满', code: 'scheduler_capacity' }
      runtime.failed.delete(id)
      if (target.delivery === 'this-session')
        return acceptDelivery(target, 'manual', new Date().toISOString())
      launchRun(target, 'manual', new Date().toISOString())
      return { ok: true }
    })
  },

  async tick(): Promise<void> {
    await withTaskQueue(async () => {
      if (runtime.stopping)
        return
      await repairOccurrences()
      let all = await task.list()
      for (const item of all.filter(item => item.status === 'active' && item.enabled && !item.nextRunAt))
        await task.ensureTarget(item)
      all = await task.list()
      const pending = await history.pending()
      for (const item of pending) {
        if (runtime.failed.has(item.task.id))
          continue
        await acceptDelivery(item.task, item.trigger, item.scheduledAt)
      }
      all = await task.list()
      for (const item of all) {
        const now = Date.now()
        if (item.status !== 'active' || !item.enabled || !item.nextRunAt || Date.parse(item.nextRunAt) > now
          || runtime.running.has(item.id) || runtime.pending.has(item.id) || runtime.failed.has(item.id)) {
          continue
        }
        const occurrence = latestDueOccurrence(item.schedule, Date.parse(item.nextRunAt!), now)
        if (occurrence === undefined)
          continue
        const scheduledAt = new Date(occurrence).toISOString()
        if (item.delivery === 'this-session')
          await acceptDelivery(item, 'schedule', scheduledAt)
        else if (runtime.running.size < SCHEDULER_MAX_CONCURRENT_RUNS)
          launchRun(item, 'schedule', scheduledAt)
      }
    })
  },

  async waitingIds(): Promise<Set<string>> {
    return selectWaitingTaskIds(await task.list(), runtime.running, SCHEDULER_MAX_CONCURRENT_RUNS - runtime.running.size, Date.now())
  },

  async stop(): Promise<void> {
    await drainRuntime()
  },
})

async function repairOccurrences(taskId?: string): Promise<void> {
  for (const item of await history.journals(taskId)) {
    if (!item.completedAt)
      continue
    const next = item.trigger === 'schedule' ? nextFutureOccurrence(item.task.schedule, Date.parse(item.scheduledAt), Date.now()) : undefined
    await task.complete(item.task, item.completedAt, next === undefined ? undefined : new Date(next).toISOString(), item.trigger === 'schedule')
    await history.acknowledge(item.id)
    runtime.flushes.delete(item.id)
    if (runtime.pending.get(item.task.id)?.message.id === item.id)
      runtime.pending.delete(item.task.id)
    runtime.failed.delete(item.task.id)
  }
}

function launchRun(target: SchedulerTask, trigger: RunTrigger, scheduledAt: string): void {
  runtime.running.add(target.id)
  const accepted = background(async () => {
    try {
      await executor.run(target, trigger, scheduledAt)
      await repairOccurrences(target.id)
    }
    catch (error) {
      runtime.failed.add(target.id)
      throw error
    }
    finally {
      runtime.running.delete(target.id)
    }
  })
  void trackAccepted(accepted).catch((error: unknown) => warn('new-session run failed', error))
}

async function acceptDelivery(target: SchedulerTask, trigger: RunTrigger, scheduledAt: string): Promise<OperationResult> {
  const accepted = background(() => delivery.run(target, trigger, scheduledAt))
  try {
    const result = await trackAccepted(accepted)
    if (!result.ok && result.code !== 'delivery_pending' && result.code !== 'delivery_not_due') {
      if (['session_archived', 'session_not_found', 'session/not-found', 'session_mismatch', 'task_invalid'].includes(result.code ?? ''))
        runtime.failed.add(target.id)
      warn('this-session delivery failed', result.error)
    }
    return result
  }
  catch (error) {
    warn('this-session delivery failed', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'delivery_failed' }
  }
}

async function sessionActivity({ sessionId }: { sessionId: string }, next: () => Promise<unknown[]>): Promise<unknown[]> {
  const items = (await task.list()).filter(item => item.delivery === 'this-session' && item.sessionId === sessionId && item.status === 'active').map(item => ({ id: item.id, label: item.name }))
  const others = await next()
  return items.length ? [{ kind: 'schedule', items }, ...others] : others
}

async function sessionStop({ sessionId }: { sessionId: string }): Promise<void> {
  await task.stopSession(sessionId)
}

function background<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = getServerContext<HostContext>(server)
  return typeof ctx.agents?.withoutInitiator === 'function' ? ctx.agents.withoutInitiator(fn) : fn()
}

function warn(message: string, error: unknown): void {
  getServerContext<HostContext>(server).logger?.warn?.(`dsh-tauri-scheduler: ${message}`, error)
}
