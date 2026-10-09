import type { Inbox } from '@deepseek-ai/dsh-agent'
import type { HostContext, PlatformModuleLoader, SessionResumeOutcome } from '../types'
import type { CreateUserMessage, PlanSession } from './session.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { contentRiskRecoveryRange, eventOf, isContentRiskFailure, lastTurnEndReason } from '../../shared/content-risk'
import { server } from '../server'

const CONTINUE_INSTRUCTION = 'Continue the interrupted task from where it stopped. Do not repeat work that is already complete.'

const CONTENT_RISK_CONTINUE_INSTRUCTION = 'The rejected turn was excluded from the visible history. Continue from the retained safe context without recreating or quoting the rejected content. If the missing task cannot be inferred safely, ask the user to restate it.'

const CONTENT_RISK_BOUNDARY_NOTICE = 'Everything below this point was removed from the visible history because the previous request was rejected by content review. The retained context above is intact; continue from it and do not recreate the removed content.'

const CONTENT_RISK_UNSAFE = '无法确定安全恢复边界，未改写会话。请新建会话重述任务，或检查该回合的工具结果内容后重试。'

// dsh ≥0.1.7 的 v4 准入拒绝 `kind: 'plugin'` 包装（format v4 message requires a producer-owned
// source kind），且上下文行标签直接取 `kind`；两代内核的默认分支都渲染 `kind`。
const CONTINUE_SOURCE = { kind: 'continue' } as const

// 恢复轮次与普通继续同源，但用 `recovery` 标记：todo 恢复必须跳过——被遮蔽回合的计划
// 属于已被审核拒绝的内容，重新挂到新回合上会重现同一失败。
const CONTENT_RISK_CONTINUE_SOURCE = { kind: 'continue', recovery: 'content-risk' } as const

// 遮蔽标记自身必须是非空 user/message：tool/result 只允许一对一改写，system/message
// 在 node 0 上受限，user/message 是唯一能遮蔽任意区间的表面事件类型。
const CONTENT_RISK_MARKER_SOURCE = { kind: 'content-risk-recovery' } as const

// 会话日志回传水位事件：内核 `dsh-session-log-deepseek` 按单一水位把水位之后的**原始**事件
// 塞进 `dsh_session_log` 请求字段（`agent/inbox/spliced` 逐字复制用户输入、工具结果也在内），
// 表面遮蔽拦不住它；插件层能写的就是这条水位记录。
const CONTENT_RISK_WATERMARK_EVENT = 'session-log-deepseek/delivery-accepted'

const SETTLED_TURN_END_KINDS = ['completed', 'blocked', 'max-tokens']

const DSH_LLM_MODULE = '@deepseek-ai/dsh-llm'

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
    const sources = messages.map(message => (message as { source?: { kind?: string, recovery?: string } } | null)?.source)
    if (!sources.some(source => source?.kind === CONTINUE_SOURCE.kind) || sources.some(source => source?.kind === 'user'))
      return
    if (sources.some(source => source?.recovery === CONTENT_RISK_CONTINUE_SOURCE.recovery))
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
  const ctx = getServerContext<HostContext>(server)
  const agent = ctx?.agents?.get?.(sessionId)
  if (agent === undefined || agent === null)
    return { ok: false, code: 404, error: '会话不存在或尚未运行' }
  if (agent.status !== 'idle')
    return { ok: false, code: 409, error: '会话仍在运行，无需继续' }
  const kind = lastTurnEndKind(agent.session)
  if (kind !== undefined && SETTLED_TURN_END_KINDS.includes(kind))
    return { ok: false, code: 409, error: `上一轮已正常结束（${kind}），无需继续` }
  if (kind === undefined)
    ctx?.logger?.warn?.(`dsh-tauri-ui: 无法从会话日志判定上一轮结束原因（session ${sessionId}），按可继续处理`)
  const createUserMessage = await loadCreateUserMessage(ctx.loader)
  if (ctx.agents.get(sessionId) !== agent || agent.status !== 'idle')
    return { ok: false, code: 409, error: '会话状态已变化，请重新尝试继续' }
  const recovery = applyContentRiskRecovery(agent.session, createUserMessage)
  if (recovery === 'unavailable')
    return { ok: false, code: 409, error: CONTENT_RISK_UNSAFE }
  const recovered = recovery === 'applied'
  const message = createUserMessage({
    content: [{ type: 'text', text: recovered ? CONTENT_RISK_CONTINUE_INSTRUCTION : CONTINUE_INSTRUCTION }],
    source: recovered ? CONTENT_RISK_CONTINUE_SOURCE : CONTINUE_SOURCE,
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

/**
 * 审核失败回合的原地恢复：在表面日志末尾追加一条遮蔽标记，让失败回合（含触发拒绝的
 * 工具结果）不再进入模型可见历史，更早的成功上下文逐字保留。
 *
 * `skipped` 表示本轮不是审核失败——走原有继续路径；`unavailable` 表示确认是审核失败
 * 但无法给出安全边界，调用方必须拒绝自动继续，绝不回放被拒上下文。
 */
function applyContentRiskRecovery(value: unknown, createUserMessage: CreateUserMessage): 'skipped' | 'applied' | 'unavailable' {
  const events = sessionEvents(value)
  if (events === undefined)
    return 'skipped'
  if (!isContentRiskFailure(lastTurnEndReason(events)?.error))
    return 'skipped'
  const nodes = sessionSurfaceNodes(value)
  const append = (value as { append?: unknown } | null)?.append
  if (nodes === undefined || typeof append !== 'function')
    return 'unavailable'
  const range = contentRiskRecoveryRange({ events, nodes })
  if (range === undefined)
    return 'unavailable'
  if (!advanceSessionLogWatermark(value, events, range.watermarkSeq))
    return 'unavailable'
  const marker = createUserMessage({
    content: [{ type: 'text', text: CONTENT_RISK_BOUNDARY_NOTICE }],
    source: CONTENT_RISK_MARKER_SOURCE,
  })
  // 水位已经推进、表面却遮蔽失败时，会话会停在「回传被截断但历史照旧」的半成品状态：
  // 后续请求仍然回放被拒内容，用户却看不到任何原因。内核拒绝 replace（节点漂移、seq
  // 不连续）会抛错，这里必须吞掉并退化为人工指引，绝不把 500 抛给前端。
  try {
    Reflect.apply(append as (...args: unknown[]) => unknown, value, ['user/message', marker, {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: range.shadowedSeqs,
    }])
  }
  catch (error) {
    getServerContext<HostContext>(server)?.logger?.warn?.(`内容审核恢复：遮蔽被拒回合失败，已放弃自动继续（${renderThrown(error)}）`)
    return 'unavailable'
  }
  return 'applied'
}

/**
 * 把会话日志回传水位推到被拒回合末尾，返回是否成功。
 *
 * 表面遮蔽只改模型可见历史：`dsh_session_log` 从水位之后逐条回传原始事件，被拒文本因此
 * 仍会到达上游并再次触发同一条拒绝。水位是单值游标（挖不了洞），只能整段推进到失败回合
 * 的 `turn/end`；更早的成功上下文不重传，只是不再随请求回传。
 *
 * 任何一环读不到（会话 id / 格式代缺失，或写入抛错）都必须返回 false——调用方据此拒绝
 * 自动继续，绝不发出一条仍带着被拒内容的请求。
 */
function advanceSessionLogWatermark(value: unknown, events: readonly unknown[], watermarkSeq: number): boolean {
  const append = (value as { append?: unknown } | null)?.append
  const sessionId = sessionIdOf(value)
  const sessionFormatVersion = sessionHeaderVersion(value)
  if (typeof append !== 'function' || sessionId === undefined || sessionFormatVersion === undefined)
    return false
  const seq = sessionSeqOf(value)
  // 内核折叠时要求 `throughSeq < event.seq`，越界记录会让该会话此后每次请求都报 malformed。
  if (seq !== undefined && watermarkSeq >= seq)
    return false
  const accepted = lastAcceptedWatermark(events, sessionId, sessionFormatVersion)
  if (accepted !== undefined && accepted >= watermarkSeq)
    return true
  try {
    Reflect.apply(append as (...args: unknown[]) => unknown, value, [CONTENT_RISK_WATERMARK_EVENT, {
      sessionId,
      sessionFormatVersion,
      throughSeq: watermarkSeq,
    }])
  }
  catch {
    return false
  }
  return true
}

/** 内核 `Session.id`（`brandString` 为恒等，即原始字符串）。 */
function sessionIdOf(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 会话格式代：水位事件必须与之一致，否则内核折叠时每条记录都报 malformed。 */
function sessionHeaderVersion(value: unknown): number | undefined {
  const version = (value as { header?: { version?: unknown } } | null)?.header?.version
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : undefined
}

/** 下一个事件序号（内核 `Session.seq`）。 */
function sessionSeqOf(value: unknown): number | undefined {
  const seq = (value as { seq?: unknown } | null)?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

/** 已折叠的最大回传水位，与内核 `acceptedThrough` 同口径（只看本会话、本格式代）。 */
function lastAcceptedWatermark(events: readonly unknown[], sessionId: string, sessionFormatVersion: number): number | undefined {
  let watermark: number | undefined
  for (const entry of events) {
    const event = eventOf(entry)
    if (event?.type !== CONTENT_RISK_WATERMARK_EVENT)
      continue
    const data = event.data as { sessionId?: unknown, sessionFormatVersion?: unknown, throughSeq?: unknown } | undefined
    if (data?.sessionId !== sessionId || (data.sessionFormatVersion ?? 0) !== sessionFormatVersion)
      continue
    if (typeof data.throughSeq !== 'number' || !Number.isSafeInteger(data.throughSeq) || data.throughSeq < 0)
      continue
    if (watermark === undefined || data.throughSeq > watermark)
      watermark = data.throughSeq
  }
  return watermark
}

function lastTurnEndKind(value: unknown): string | undefined {
  const events = sessionEvents(value)
  if (events === undefined)
    return undefined
  const kind = lastTurnEndReason(events)?.kind
  return typeof kind === 'string' ? kind : undefined
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

/** 模型可见表面节点（`surface.nodes`）；内核缺这一面时恢复必须退化为人工提示。 */
function sessionSurfaceNodes(value: unknown): readonly number[] | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const nodes = (value as { surface?: { nodes?: unknown } }).surface?.nodes
  return Array.isArray(nodes) && nodes.every(node => typeof node === 'number') ? nodes as readonly number[] : undefined
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
