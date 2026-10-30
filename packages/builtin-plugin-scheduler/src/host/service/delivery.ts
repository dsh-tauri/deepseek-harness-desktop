import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HostContext, OperationResult, RunTrigger, SchedulerTask } from '../types'
import type { PlatformModuleLoader } from '../utils/agent-runtime.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { runtime } from '../config/runtime'
import { server } from '../server'
import { isSchedulerSessionNotFound, loadSchedulerMessageFactory } from '../utils/agent-runtime'
import { nextFutureOccurrence } from '../utils/occurrence'
import { SessionOperationTimeout, withSessionDeadline } from '../utils/session-deadline'
import { sameTaskRecord } from '../utils/task-record'
import { history } from './history'
import { task } from './task'

export const delivery = defineService({
  async run(target: SchedulerTask, trigger: RunTrigger, scheduledAt: string): Promise<OperationResult> {
    const ctx = getServerContext<HostContext>(server)
    if (typeof ctx.sessionController?.resolveAgent !== 'function' || typeof ctx.sessionController?.inspect !== 'function' || typeof ctx.sessions?.flush !== 'function')
      return { ok: false, error: '宿主无法恢复或持久化目标会话', code: 'session_unavailable' }
    let pending = runtime.pending.get(target.id) ?? (await history.pending(target.id))[0]
    let enqueued = runtime.pending.has(target.id)
    if (pending && !enqueued) {
      try {
        const inspected = await withSessionDeadline<Awaited<ReturnType<SessionController['inspect']>>>(ctx.sessionController.inspect(pending.task.sessionId!))
        enqueued = containsMessage(inspected.events, pending.message.id)
      }
      catch (error) {
        if (error instanceof SessionOperationTimeout)
          return { ok: false, error: error.message, code: 'session_unavailable' }
        return await isSchedulerSessionNotFound(ctx.loader, error)
          ? { ok: false, error: '目标会话不存在', code: 'session_not_found' }
          : { ok: false, error: '宿主无法读取目标会话', code: 'session_unavailable' }
      }
    }
    const snapshot = pending?.task ?? target
    const occurrence = pending?.scheduledAt ?? scheduledAt
    const runTrigger = pending?.trigger ?? trigger
    if (!enqueued) {
      const allowed = await canEnqueue(snapshot, runTrigger, occurrence)
      if (allowed === 'changed') {
        if (pending)
          await history.discardPending(target.id)
        return { ok: true }
      }
      if (allowed === 'future')
        return { ok: false, error: '计划尚未到期', code: 'delivery_not_due' }
    }
    const bound = await task.validateTarget(snapshot)
    if (!bound.ok)
      return bound
    let resolved: Awaited<ReturnType<SessionController['resolveAgent']>>
    try {
      resolved = await withSessionDeadline<Awaited<ReturnType<SessionController['resolveAgent']>>>(ctx.sessionController.resolveAgent(snapshot.sessionId!))
    }
    catch (error) {
      if (error instanceof SessionOperationTimeout)
        return { ok: false, error: error.message, code: 'session_unavailable' }
      throw error
    }
    if ('error' in resolved)
      return { ok: false, error: resolved.error.message, code: resolved.error.code }
    const agent = resolved.agent
    const rechecked = await task.validateTarget(snapshot)
    if (!rechecked.ok)
      return rechecked
    if (agent.session?.id !== snapshot.sessionId)
      return { ok: false, error: '恢复的会话与任务绑定不匹配', code: 'session_mismatch' }
    if (!enqueued) {
      const allowed = await canEnqueue(snapshot, runTrigger, occurrence)
      if (allowed === 'changed') {
        if (pending)
          await history.discardPending(target.id)
        return { ok: true }
      }
      if (allowed === 'future')
        return { ok: false, error: '计划尚未到期', code: 'delivery_not_due' }
    }
    if (!pending) {
      const createMessage = await loadSchedulerMessageFactory(ctx.loader as PlatformModuleLoader)
      const message = createMessage({
        content: [{ type: 'text', text: framing(target, scheduledAt) }],
        source: { kind: 'schedule', form: 'notice', summary: `Scheduled: ${target.name}`.slice(0, 120) },
      })
      if (typeof message.id !== 'string')
        throw new TypeError('SCHEDULER_MESSAGE_ID_MISSING')
      pending = { task: target, trigger, scheduledAt, deliveredAt: new Date().toISOString(), message }
      await history.prepare(pending)
    }
    if (!enqueued) {
      const allowed = await canEnqueue(snapshot, runTrigger, occurrence)
      if (allowed === 'changed') {
        await history.discardPending(target.id)
        return { ok: true }
      }
      if (allowed === 'future')
        return { ok: false, error: '计划尚未到期', code: 'delivery_not_due' }
      if (ctx.workspaceRegistry.archivedSessionIds.includes(snapshot.sessionId))
        return { ok: false, error: '目标会话已归档', code: 'session_archived' }
      agent.followup(pending.message)
    }
    runtime.pending.set(target.id, pending)
    let flush = runtime.flushes.get(pending.message.id)
    if (!flush) {
      flush = Promise.resolve(ctx.sessions.flush(agent.session))
      runtime.flushes.set(pending.message.id, flush)
      const identity = pending.message.id
      void flush.then((acknowledged) => {
        if (acknowledged !== true && runtime.flushes.get(identity) === flush)
          runtime.flushes.delete(identity)
      }, () => {
        if (runtime.flushes.get(identity) === flush)
          runtime.flushes.delete(identity)
      })
    }
    let flushed: boolean
    try {
      flushed = await withSessionDeadline(flush)
    }
    catch (error) {
      if (error instanceof SessionOperationTimeout)
        return { ok: false, error: 'Session persistence did not acknowledge the reminder', code: 'delivery_pending' }
      throw error
    }
    if (flushed !== true)
      return { ok: false, error: 'Session persistence did not acknowledge the reminder', code: 'delivery_pending' }
    pending.deliveredAt = new Date().toISOString()
    const next = pending.trigger === 'schedule' ? nextFutureOccurrence(pending.task.schedule, Date.parse(pending.scheduledAt), Date.now()) : undefined
    pending.nextRunAt = next === undefined ? undefined : new Date(next).toISOString()
    await history.commit(pending)
    await task.complete(pending.task, pending.deliveredAt, pending.nextRunAt, pending.trigger === 'schedule')
    await history.acknowledge(pending.message.id)
    runtime.flushes.delete(pending.message.id)
    runtime.pending.delete(target.id)
    return { ok: true }
  },
})

async function canEnqueue(snapshot: SchedulerTask, trigger: RunTrigger, scheduledAt: string): Promise<'ready' | 'changed' | 'future'> {
  const current = await task.get(snapshot.id)
  if (!sameTaskRecord(current, snapshot) || current?.status !== 'active' || (trigger === 'schedule' && !current.enabled))
    return 'changed'
  return trigger === 'schedule' && Date.parse(scheduledAt) > Date.now() ? 'future' : 'ready'
}

function framing(target: SchedulerTask, scheduledAt: string): string {
  return [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user.',
    'This reminder may have been queued while the session was busy. Check the current conversation before acting; do not override a newer request or repeat completed work. Ask for clarification if its context is stale.',
    `schedule_id_json: ${JSON.stringify(target.id)}`,
    `occurrence_at: ${scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(target.prompt)}`,
  ].join('\n')
}

function containsMessage(events: readonly SessionEvent[], id: string): boolean {
  return events.some(event => (event.type === 'user/message' && event.data.id === id)
    || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === id)))
}
