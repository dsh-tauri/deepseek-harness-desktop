import type { Inbox } from '@deepseek-ai/dsh-agent'
import type { PlatformModuleLoader, SessionResumeOutcome } from '../types'
import type { CreateUserMessage, PlanSession } from './session.types'
import { defineService } from 'dsh-tauri'
import { getCurrentHostInstance } from '../config/runtime'

const CONTINUE_INSTRUCTION = 'Continue the interrupted task from where it stopped. Do not repeat work that is already complete.'

// dsh ≥0.1.7 的 v4 准入拒绝 `kind: 'plugin'` 包装（format v4 message requires a producer-owned
// source kind），且上下文行标签直接取 `kind`；两代内核的默认分支都渲染 `kind`。
const CONTINUE_SOURCE = { kind: 'continue' } as const

const SETTLED_TURN_END_KINDS = ['completed', 'blocked', 'max-tokens']

const DSH_LLM_MODULE = '@deepseek-ai/dsh-llm'

// 已知的内容审核拒绝：再灌一次「继续」只会被同一份上下文原样驳回（issue #928），
// 必须改走不改动原会话的安全恢复入口，而不是把用户丢进必然失败的循环。
const CONTENT_RISK_PATTERN = /content exists risk/i

interface SessionResumeRefusal {
  message: string
  code: string
  status: number
}

export const session = defineService({
  async resume(sessionId: string): Promise<SessionResumeOutcome> {
    try {
      return await resumeStoppedTurn(sessionId)
    }
    catch (error) {
      return { ok: false, code: 500, error: renderThrown(error) }
    }
  },
  restorePlan(value: PlanSession, messages: readonly unknown[], step: number): void {
    if (step !== 1)
      return
    const kinds = messages.map(message => (message as { source?: { kind?: string } } | null)?.source?.kind)
    if (!kinds.includes(CONTINUE_SOURCE.kind) || kinds.includes('user'))
      return
    const events = sessionEvents(value)
    if (events === undefined || typeof value.append !== 'function')
      return
    let currentTurn = false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: string, data?: { todos?: unknown } }
      if (!currentTurn && event?.type === 'turn/end')
        return
      if (event?.type === 'turn/start') {
        if (currentTurn)
          return
        currentTurn = true
      }
      if (event?.type === 'todo/write') {
        if (currentTurn && Array.isArray(event.data?.todos))
          value.append('todo/write', { todos: event.data.todos })
        return
      }
    }
  },
})

// --- internal ---

async function resumeStoppedTurn(sessionId: string): Promise<SessionResumeOutcome> {
  const ctx = getCurrentHostInstance()
  const agent = ctx?.agents?.get?.(sessionId)
  if (agent === undefined || agent === null)
    return { ok: false, code: 404, error: '会话不存在或尚未运行' }
  if (agent.status !== 'idle')
    return { ok: false, code: 409, error: '会话仍在运行，无需继续' }
  const kind = lastTurnEndKind(agent.session)
  if (kind !== undefined && SETTLED_TURN_END_KINDS.includes(kind))
    return { ok: false, code: 409, error: `上一轮已正常结束（${kind}），无需继续` }
  const refusal = lastTurnEndRefusal(agent.session)
  if (refusal !== undefined)
    return { ok: false, code: 409, error: refusal.message, refusal }
  if (kind === undefined)
    ctx?.logger?.warn?.(`dsh-tauri-ui: 无法从会话日志判定上一轮结束原因（session ${sessionId}），按可继续处理`)
  const createUserMessage = await loadCreateUserMessage(ctx.loader)
  if (ctx.agents.get(sessionId) !== agent || agent.status !== 'idle')
    return { ok: false, code: 409, error: '会话状态已变化，请重新尝试继续' }
  const message = createUserMessage({
    content: [{ type: 'text', text: CONTINUE_INSTRUCTION }],
    source: CONTINUE_SOURCE,
  })
  const inbox = agent.inbox
  if (!Array.isArray(inbox?.nextTurn) || typeof agent.followup !== 'function')
    throw new TypeError('DSH_CONTINUE_API_MISSING: agent.inbox.nextTurn / agent.followup')
  if (inbox.nextTurn.length === 0) {
    agent.followup(message)
    return { ok: true }
  }
  const splice: Inbox['splice'] = inbox.splice
  const descriptor = Object.getOwnPropertyDescriptor(inbox, 'splice')
  if (typeof splice !== 'function' || (descriptor
    ? !descriptor.configurable && (!('value' in descriptor) || !descriptor.writable)
    : !Object.isExtensible(inbox))) {
    throw new TypeError('DSH_CONTINUE_API_MISSING: writable agent.inbox.splice')
  }
  let intercepted = false
  let installed = false
  const restore = () => {
    if (!installed)
      return
    if (descriptor)
      Object.defineProperty(inbox, 'splice', descriptor)
    else
      Reflect.deleteProperty(inbox, 'splice')
    installed = false
  }
  // 在 driver 首次插入前调整本次继续的位置；通知重入前还原，避免删除产生 canceled 记录。
  const prioritizedSplice: Inbox['splice'] = function (this: Inbox, target, start, deleteCount, inserted) {
    if (this === inbox && target === 'next-turn' && deleteCount === 0 && inserted.length === 1 && inserted[0].id === message.id) {
      intercepted = true
      restore()
      return splice.call(this, target, 0, deleteCount, inserted)
    }
    return splice.call(this, target, start, deleteCount, inserted)
  }
  Object.defineProperty(inbox, 'splice', {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: prioritizedSplice,
  })
  installed = true
  try {
    agent.followup(message)
    if (!intercepted)
      throw new TypeError('DSH_CONTINUE_API_MISSING: followup must use agent.inbox.splice')
  }
  finally {
    restore()
  }
  return { ok: true }
}

function lastTurnEndRefusal(value: unknown): SessionResumeRefusal | undefined {
  const events = sessionEvents(value)
  if (events === undefined)
    return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string, data?: { reason?: { kind?: unknown, error?: unknown } } }
    if (event?.type !== 'turn/end')
      continue
    const reason = event.data?.reason
    if (reason?.kind !== 'error')
      return undefined
    const error = reason.error as { message?: unknown, code?: unknown, status?: unknown } | undefined
    if (error?.code !== 'INVALID_REQUEST' || error.status !== 400 || typeof error.message !== 'string')
      return undefined
    if (!CONTENT_RISK_PATTERN.test(error.message))
      return undefined
    return { message: error.message, code: 'INVALID_REQUEST', status: 400 }
  }
  return undefined
}

function lastTurnEndKind(value: unknown): string | undefined {
  const events = sessionEvents(value)
  if (events === undefined)
    return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string, data?: { reason?: { kind?: unknown } } }
    if (event?.type !== 'turn/end')
      continue
    const kind = event.data?.reason?.kind
    return typeof kind === 'string' ? kind : undefined
  }
  return undefined
}

/** 内核 `Session` 的日志面逐版本漂移：`snapshotEvents()` 为准，`log` / `events` 仅作兜底。 */
function sessionEvents(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const session = value as Record<string, unknown>
  const snapshotEvents = session.snapshotEvents
  if (typeof snapshotEvents === 'function') {
    const snapshot: unknown = Reflect.apply(snapshotEvents, value, [])
    if (Array.isArray(snapshot))
      return snapshot
  }
  if (Array.isArray(session.log))
    return session.log
  return Array.isArray(session.events) ? session.events : undefined
}

async function loadCreateUserMessage(loader: PlatformModuleLoader | undefined): Promise<CreateUserMessage> {
  if (typeof loader?.import !== 'function')
    throw new TypeError('DSH_LOADER_MISSING: ctx.loader')
  const moduleExports = await loader.import(DSH_LLM_MODULE)
  const direct = (moduleExports as { createUserMessage?: unknown } | null)?.createUserMessage
  if (typeof direct === 'function')
    return direct as CreateUserMessage
  const unwrapped = loader.unwrapExports(moduleExports) as { createUserMessage?: unknown } | null
  if (typeof unwrapped?.createUserMessage !== 'function')
    throw new TypeError('DSH_LLM_EXPORT_MISSING: createUserMessage')
  return unwrapped.createUserMessage as CreateUserMessage
}

function renderThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
