import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { HostContext, OperationResult, SchedulerSchedule, SchedulerTask, TaskInput } from '../types'
import { randomUUID } from 'node:crypto'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { isEqual } from 'lodash-es'
import { runtime, withTaskQueue, withWriteQueue } from '../config/runtime'
import { server } from '../server'
import { storage } from '../storage'
import { isSchedulerSessionNotFound } from '../utils/agent-runtime'
import { localTimeZone, nextOccurrence, validateSchedule } from '../utils/schedule'
import { SessionOperationTimeout, withSessionDeadline } from '../utils/session-deadline'
import { sameTaskRecord } from '../utils/task-record'

const SCHEDULER_TASKS_KEY = 'tasks'
const SCHEDULER_PROMPT_MAX_LENGTH = 64_000
const SCHEDULER_NAME_MAX_LENGTH = 120
const RESOURCE_FIELDS = ['workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'] as const
const TEXT_FIELDS = ['recommendationId', ...RESOURCE_FIELDS] as const

export const task = defineService({
  async list(search?: string): Promise<SchedulerTask[]> {
    const all = await readAll()
    const needle = search?.trim().toLowerCase() ?? ''
    return needle === '' ? all : all.filter(item => item.name.toLowerCase().includes(needle))
  },

  async get(id: string): Promise<SchedulerTask | null> {
    return (await readAll()).find(item => item.id === id) ?? null
  },

  async create(input: TaskInput): Promise<OperationResult<{ task: SchedulerTask }>> {
    const initiator = input?.delivery === 'this-session' ? currentInitiator() : undefined
    return withTaskQueue(() => withWriteQueue(async () => {
      if (runtime.stopping)
        return unavailable()
      const invalid = validateInput(input)
      if (invalid !== null)
        return { ok: false, error: invalid, code: 'task_invalid' }
      const sessionId = input.delivery === 'this-session' ? input.sessionId || initiator?.session.id : undefined
      const bound = await validateBinding(input, sessionId, initiator?.session.id)
      if (!bound.ok)
        return bound
      const created = build({ ...input, sessionId })
      const all = await readAll()
      all.push(created)
      await writeTasks(all)
      return { ok: true, task: created }
    }))
  },

  async update(id: string, patch: Partial<TaskInput>, expected?: SchedulerTask): Promise<OperationResult<{ task: SchedulerTask }>> {
    const initiator = currentInitiator()
    return withTaskQueue(() => withWriteQueue(async () => {
      if (runtime.stopping)
        return unavailable()
      const all = await readAll()
      const at = all.findIndex(item => item.id === id)
      if (at === -1)
        return notFound()
      const current = all[at]!
      if (expected !== undefined && !sameTaskRecord(current, expected))
        return { ok: false, error: '任务已发生变化，请刷新后重试', code: 'task_conflict' }
      if (current.status === 'inactive')
        return inactive()
      if (runtime.running.has(id))
        return { ok: false, error: '任务正在执行中，暂不能修改任务', code: 'task_busy' }
      if (runtime.pending.has(id))
        return { ok: false, error: '投递正在等待会话持久化，暂不能修改任务', code: 'task_pending' }
      const definedPatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined))
      const merged = { ...current, ...definedPatch } as TaskInput
      if (merged.delivery === 'this-session' && !merged.sessionId)
        merged.sessionId = initiator?.session.id
      if (merged.delivery === 'new-session') {
        if (patch.sessionId !== undefined && patch.sessionId !== '')
          return { ok: false, error: '新会话投递不能绑定 sessionId', code: 'task_invalid' }
        delete merged.sessionId
      }
      const invalid = validateInput(merged)
      if (invalid !== null)
        return { ok: false, error: invalid, code: 'task_invalid' }
      const bindingChanged = merged.delivery !== current.delivery || merged.sessionId !== current.sessionId
      const bound = await validateBinding(merged, merged.sessionId, initiator?.session.id, bindingChanged)
      if (!bound.ok)
        return bound
      const rebuilt = build(merged)
      runtime.failed.delete(id)
      const updated: SchedulerTask = {
        ...current,
        ...rebuilt,
        id: current.id,
        status: current.status,
        createdAt: current.createdAt,
        lastRunAt: current.lastRunAt,
        nextRunAt: isEqual(rebuilt.schedule, current.schedule) ? current.nextRunAt : rebuilt.nextRunAt,
      }
      for (const field of TEXT_FIELDS) {
        if (!merged[field])
          delete updated[field]
      }
      if (updated.delivery === 'new-session')
        delete updated.sessionId
      delete updated.waiting
      all[at] = updated
      await writeTasks(all)
      return { ok: true, task: updated }
    }))
  },

  async remove(id: string): Promise<OperationResult> {
    return withTaskQueue(() => withWriteQueue(async () => {
      const all = await readAll()
      const remaining = all.filter(item => item.id !== id)
      if (remaining.length === all.length)
        return notFound()
      await writeTasks(remaining)
      return { ok: true }
    }))
  },

  async toggle(id: string, enabled: boolean): Promise<OperationResult<{ task: SchedulerTask }>> {
    if (typeof enabled !== 'boolean')
      return { ok: false, error: 'enabled 必须是布尔值', code: 'task_invalid' }
    return task.update(id, { enabled })
  },

  async complete(expected: SchedulerTask, lastRunAt: string, nextRunAt?: string, consume = true): Promise<boolean> {
    return withWriteQueue(async () => {
      const all = await readAll()
      const at = all.findIndex(item => item.id === expected.id)
      if (at === -1 || !sameTaskRecord(all[at]!, expected))
        return false
      all[at] = {
        ...all[at]!,
        lastRunAt,
        nextRunAt: consume ? nextRunAt : all[at]!.nextRunAt,
        status: consume && nextRunAt === undefined ? 'inactive' : all[at]!.status,
        updatedAt: new Date().toISOString(),
      }
      await writeTasks(all)
      return true
    })
  },

  async ensureTarget(expected: SchedulerTask): Promise<void> {
    await withWriteQueue(async () => {
      const all = await readAll()
      const at = all.findIndex(item => item.id === expected.id)
      if (at === -1 || !sameTaskRecord(all[at]!, expected) || expected.status !== 'active' || expected.nextRunAt)
        return
      const next = expected.schedule.kind === 'once' ? Date.parse(expected.schedule.at) : nextOccurrence(expected.schedule, Date.now())
      all[at] = { ...all[at]!, nextRunAt: next === undefined ? undefined : new Date(next).toISOString(), status: next === undefined ? 'inactive' : 'active' }
      await writeTasks(all)
    })
  },

  async stopSession(sessionId: string): Promise<void> {
    await withTaskQueue(() => withWriteQueue(async () => {
      const all = await readAll()
      const next = all.map(item => item.delivery === 'this-session' && item.sessionId === sessionId && item.status === 'active'
        ? { ...item, status: 'inactive' as const, enabled: false, nextRunAt: undefined, updatedAt: new Date().toISOString() }
        : item)
      if (!isEqual(next, all))
        await writeTasks(next)
    }))
  },

  async validateTarget(item: SchedulerTask): Promise<OperationResult> {
    return validateBinding(item, item.sessionId)
  },
})

async function readAll(): Promise<SchedulerTask[]> {
  const raw = await storage.getItem<{ tasks?: unknown[] }>(SCHEDULER_TASKS_KEY)
  return (Array.isArray(raw?.tasks) ? raw.tasks : []).flatMap((value) => {
    if (!isStoredTask(value))
      return []
    const next = { ...value, delivery: value.delivery ?? 'new-session', status: value.status ?? 'active' } as SchedulerTask
    delete next.waiting
    if (next.delivery === 'new-session')
      delete next.sessionId
    return [next]
  })
}

function isStoredTask(value: unknown): value is SchedulerTask {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const item = value as Partial<SchedulerTask>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.prompt === 'string'
    && typeof item.enabled === 'boolean' && validateSchedule(item.schedule)
    && (item.delivery === undefined || item.delivery === 'new-session' || (item.delivery === 'this-session' && typeof item.sessionId === 'string' && item.sessionId.length > 0))
    && (item.status === undefined || item.status === 'active' || item.status === 'inactive')
}

async function writeTasks(all: SchedulerTask[]): Promise<void> {
  await storage.setItem(SCHEDULER_TASKS_KEY, `${JSON.stringify({ version: 2, tasks: all }, null, 2)}\n`)
}

function build(input: TaskInput): SchedulerTask {
  const now = new Date()
  const schedule = input.schedule
  const anchor = (schedule.kind === 'interval' || schedule.kind === 'custom') && !schedule.anchor
    ? { ...schedule, anchor: now.toISOString() }
    : schedule
  const normalized = { ...anchor, timeZone: anchor.timeZone || localTimeZone() } as SchedulerSchedule
  const next = nextOccurrence(normalized, now.getTime())
  return {
    id: `task-${randomUUID()}`,
    delivery: input.delivery,
    status: 'active',
    ...(input.delivery === 'this-session' ? { sessionId: input.sessionId } : {}),
    name: input.name.trim(),
    schedule: normalized,
    prompt: input.prompt,
    ...Object.fromEntries(TEXT_FIELDS.filter(field => input[field]).map(field => [field, input[field]])),
    enabled: input.enabled ?? true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: next === undefined ? undefined : new Date(next).toISOString(),
  }
}

function validateInput(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return '请求体必须是对象'
  const value = input as Partial<TaskInput>
  if (value.delivery !== 'this-session' && value.delivery !== 'new-session')
    return '必须明确选择 delivery：this-session 或 new-session'
  if (typeof value.name !== 'string' || value.name.trim() === '')
    return '任务名称不能为空'
  if (value.name.trim().length > SCHEDULER_NAME_MAX_LENGTH)
    return `任务名称不能超过 ${SCHEDULER_NAME_MAX_LENGTH} 个字符`
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '')
    return '任务指令不能为空'
  if (value.prompt.length > SCHEDULER_PROMPT_MAX_LENGTH)
    return `任务指令不能超过 ${SCHEDULER_PROMPT_MAX_LENGTH} 个字符`
  const schedule = value.schedule?.kind === 'custom' && !value.schedule.anchor ? { ...value.schedule, anchor: new Date().toISOString() } : value.schedule
  if (!validateSchedule(schedule))
    return '计划配置无效'
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    return 'enabled 必须是布尔值'
  if (TEXT_FIELDS.some(field => value[field] !== undefined && typeof value[field] !== 'string'))
    return '资源配置必须是字符串'
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string')
    return 'sessionId 必须是字符串'
  return null
}

function currentInitiator(): { session: { id: string } } | undefined {
  return getServerContext<HostContext>(server).agents?.currentInitiator?.()
}

async function validateBinding(input: Pick<TaskInput, 'delivery' | 'sessionId' | 'workspaceId' | 'permission' | 'provider' | 'model' | 'reasoningEffort'>, sessionId?: string, initiatorId?: string, verifySession = true): Promise<OperationResult> {
  if (input.delivery === 'new-session')
    return input.sessionId ? { ok: false, error: '新会话投递不能绑定 sessionId', code: 'task_invalid' } : { ok: true }
  if (!sessionId)
    return { ok: false, error: '原会话投递缺少可确认的 sessionId', code: 'session_unavailable' }
  if (initiatorId && sessionId !== initiatorId)
    return { ok: false, error: '不能代表另一个会话创建原会话任务', code: 'session_mismatch' }
  if (RESOURCE_FIELDS.some(field => input[field]))
    return { ok: false, error: '原会话投递继承会话资源，不能覆盖工作区、权限或模型', code: 'task_invalid' }
  if (!verifySession)
    return { ok: true }
  const ctx = getServerContext<HostContext>(server)
  if (typeof ctx.sessionController?.inspect !== 'function' || !Array.isArray(ctx.workspaceRegistry?.archivedSessionIds))
    return { ok: false, error: '宿主无法验证目标会话', code: 'session_unavailable' }
  if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId))
    return { ok: false, error: '目标会话已归档', code: 'session_archived' }
  try {
    const inspected = await withSessionDeadline<Awaited<ReturnType<SessionController['inspect']>>>(ctx.sessionController.inspect(sessionId))
    if (inspected?.meta?.id !== sessionId)
      return { ok: false, error: '目标会话不存在', code: 'session_not_found' }
    if (inspected.meta.origin === 'subagent' || (inspected.meta.delegationDepth ?? 0) > 0)
      return { ok: false, error: '不能为子代理会话创建原会话任务', code: 'session_mismatch' }
    if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId))
      return { ok: false, error: '目标会话已归档', code: 'session_archived' }
    return { ok: true }
  }
  catch (error) {
    if (error instanceof SessionOperationTimeout)
      return { ok: false, error: error.message, code: 'session_unavailable' }
    return await isSchedulerSessionNotFound(ctx.loader, error)
      ? { ok: false, error: '目标会话不存在', code: 'session_not_found' }
      : { ok: false, error: '宿主无法读取目标会话', code: 'session_unavailable' }
  }
}

function notFound(): OperationResult<never> {
  return { ok: false, error: '任务不存在', code: 'task_not_found' }
}

function inactive(): OperationResult<never> {
  return { ok: false, error: '任务已结束，不能重新启用或运行', code: 'task_inactive' }
}

function unavailable(): OperationResult<never> {
  return { ok: false, error: '调度器正在卸载', code: 'scheduler_stopping' }
}
