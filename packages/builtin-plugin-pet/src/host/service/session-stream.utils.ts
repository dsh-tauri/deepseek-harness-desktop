import type { PetSessionPayload, PetToolActivity, PetWorkStatus } from '../types'
import type {
  PetGoalClosing,
  PetSessionEvent,
  PetSessionPeer,
  PetSessionState,
} from './session-stream.types'

/** 推理文本滚动尾部窗口字符数：超出后丢弃最早内容，供气泡「思考 · text」实时滚动展示。 */
export const PET_REASONING_TAIL_WINDOW = 120
/** 推理文本推送间隔（毫秒）：状态实时累积，最多每 500ms 推送一次最新尾部，避免逐 token 洪泛。 */
export const PET_REASONING_PUSH_INTERVAL_MS = 500
/** 任务文案最大码点数：气泡最大宽只有宠物宽的 0.5 倍，超出即截断加省略号。 */
export const PET_TASK_TEXT_MAX = 40

/**
 * service/session-stream.utils.ts — 纯函数「会话增量 → 桌宠展示态」reducer。
 *
 * 宿主没有客户端已合并的快照，因此必须把增量状态化重建成桌宠需要的展示态；与 dsh-dafeiyu
 * 的 companion-reducer 同类，但只投影桌宠白名单字段。所有成员无副作用、可注入时钟，供
 * hermetic 单测。
 *
 * 增量有**两条**来源，缺一不可：
 * - `session/event`（持久化事件总线）：turn/step/tool/approval/todo/title 等边界事件；
 * - `agent/assistant-stream`（agent-scoped 活体帧）：逐 token 的 reasoning/text 增量。核心
 *   0.1.6 起流式增量不再落成 `assistant/chunk` 会话事件，只走这条帧通道（见 `chunk()`）。
 */

/**
 * 维持 per-session 累计态 + lastSent 去重，只在展示态真的变化时回调。
 *
 * 推理文本（流式 reasoning-delta）按 `PET_REASONING_PUSH_INTERVAL_MS` 节流：
 * 状态实时累积，但最多每 500ms 推送一次最新尾部，避免逐 token 洪泛。
 *
 * @param handle - 变化时回调 (action, payload)。
 * @param opts - 可选配置。
 * @param opts.now - 注入时钟（ms），供单测 hermetic 推进时间。
 */
export function createPetSessionReducer(
  handle: (action: 'create' | 'update' | 'remove', payload: PetSessionPayload) => void,
  opts?: { now?: () => number },
) {
  const now = opts?.now ?? (() => Date.now())
  const states = new Map<string, PetSessionState>()
  const lastSent = new Map<string, PetSessionPayload>()
  const lastReasoningPushAt = new Map<string, number>()

  /** 增量事件驱动：更新态，变化才 push update。 */
  const applyEvent = (peer: PetSessionPeer, event: PetSessionEvent): void => {
    let state = states.get(peer.id)
    if (state === undefined) {
      state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
    }
    // 每次事件后用 peer 最新身份字段覆盖（title/origin/running 是权威来源）。
    state.title = peer.title ?? state.title
    state.displayTitle = peer.displayTitle ?? state.displayTitle
    state.origin = peer.origin ?? state.origin
    state.cwd = peer.cwd ?? state.cwd

    const payload = reduceSessionEvent(state, event)
    if (payload === null)
      return
    // 推理文本节流：仅对流式 reasoning-delta 生效，边界事件立即推送。
    if (event.type === 'assistant/chunk' && payload.liveActivity?.kind === 'reasoning') {
      const at = now()
      const last = lastReasoningPushAt.get(peer.id) ?? 0
      if (at - last < PET_REASONING_PUSH_INTERVAL_MS)
        return
      lastReasoningPushAt.set(peer.id, at)
    }
    const previous = lastSent.get(peer.id)
    if (previous && payloadEqual(previous, payload))
      return
    lastSent.set(peer.id, payload)
    handle('update', payload)
  }

  return {
    /** 会话出生：建态并 push create。 */
    create(peer: PetSessionPeer): void {
      const state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
      const payload = foldPetPayload(state)
      lastSent.set(peer.id, payload)
      handle('create', payload)
    },

    apply: applyEvent,

    /**
     * 活体流式 chunk（核心 0.1.6 起流式增量走 agent-scoped 的
     * `agent/assistant-stream` 帧，不再作为 `assistant/chunk` 会话事件发布）。
     *
     * 帧里的 `chunk` 与旧事件的 `data.chunk` 同形（`reasoning-delta` / `text-delta` / …），
     * 因此这里折叠成一条合成 `assistant/chunk` 事件复用同一段增量语义 —— 推理尾部窗口、
     * 500ms 节流、与 lastSent 的去重都只有一份实现。
     */
    chunk(peer: PetSessionPeer, chunk: unknown): void {
      applyEvent(peer, {
        type: 'assistant/chunk',
        seq: 0,
        time: now(),
        data: { chunk },
      })
    },

    /**
     * agent 空闲兜底（宿主 `agent/status → idle`）。
     *
     * 【为什么必须有】`turn/end` 不是「回合收尾」的可靠信号：核心在异常收尾时可能**永远不追加**
     * 它——真实现场（用户中止一个刚起流的会话）里日志只有 `assistant/attempt` + `step/end`，
     * `turn/end` 直到会话重新加载时才由崩溃修复以 `interrupted` 补写，而崩溃修复不会再走
     * `session/event`。桌宠只认 `turn/end`，于是永远停在「思考中」气泡 + 循环工作动画。
     *
     * 【为什么限定 inTurn】`agent/status → idle` 总是紧跟在 `turn/end` 之后（同一轮收尾）；
     * 只有当回合内标志仍然成立（说明 `turn/end` 根本没到）才改写，避免把刚由 turn/end 写好的
     * 终态档（success 庆祝 / error 失败）与 blocked 等待态立刻清掉。
     */
    idle(id: string): void {
      const state = states.get(id)
      if (state === undefined || !inTurn(state))
        return
      settleIdle(state)
      const payload = foldPetPayload(state)
      const previous = lastSent.get(id)
      if (previous && payloadEqual(previous, payload))
        return
      lastSent.set(id, payload)
      handle('update', payload)
    },

    /** 会话消失：push remove 并清态。 */
    remove(id: string): void {
      states.delete(id)
      lastSent.delete(id)
      lastReasoningPushAt.delete(id)
      handle('remove', { id })
    },

    /** 清空累计态与其去重快照（无消费者时调用）。 */
    clear(): void {
      states.clear()
      lastSent.clear()
      lastReasoningPushAt.clear()
    },
  }
}

// --- internal ---

/** 新建一个会话的累计态。 */
function createPetSessionState(id: string, peer: PetSessionPeer): PetSessionState {
  return {
    id,
    origin: peer.origin,
    title: peer.title,
    displayTitle: peer.displayTitle,
    cwd: peer.cwd,
    running: peer.running ?? false,
    turnActive: false,
    stepActive: false,
    openTools: new Map(),
    reasoningTail: '',
    assistantText: '',
  }
}

/** 从累计态 fold 出当前展示 payload（只投影桌宠关心的字段）。 */
function foldPetPayload(state: PetSessionState): PetSessionPayload {
  const firstTool = state.openTools.values().next().value
  // 活动优先级：正在等结果的工具调用 > 累计的 reasoning 文本 > 无。
  const liveActivity = state.running && firstTool !== undefined
    ? toolActivity(firstTool.name, firstTool.args)
    : state.running && state.reasoningTail.length > 0
      ? { kind: 'reasoning', text: state.reasoningTail }
      : undefined

  let status: string | undefined
  if (state.lastAgentError)
    status = 'error'
  else if (state.waitingKind)
    status = 'waiting'
  else if (state.running || state.turnActive)
    status = 'running'

  return {
    id: state.id,
    origin: state.origin,
    title: state.title ?? state.displayTitle,
    displayTitle: state.displayTitle,
    message: state.assistantText || undefined,
    status,
    activity: status,
    phase: state.waitingKind,
    running: state.running,
    lastAgentError: state.lastAgentError,
    workStatus: state.workStatus,
    task: state.task,
    toolActivity: state.toolActivity,
    liveActivity,
  }
}

/** 工具名 → 活动分类（气泡按分类选文案）。 */
function toolActivityOf(name?: string): PetToolActivity {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value))
    return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value))
    return 'editing'
  if (/test|check|lint|build|verify/.test(value))
    return 'testing'
  if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value))
    return 'commanding'
  return 'using-tool'
}

/**
 * 本回合是否为 goal **自动续跑轮**：`user/message` 的 source 标记 `kind === 'goal'` 且 `round > 0`。
 *
 * `round === 0` 是用户 `/goal` 触发的激活轮（内核 `isGoalRound` 同样只把 `round > 0` 计入续跑轮），
 * 其终局语义按普通回合处理。
 */
function isGoalRoundEvent(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: string, round?: number } | undefined
  return source?.kind === 'goal' && typeof source.round === 'number' && source.round > 0
}

/** 是否为「替换既有事件区间」的记账事件（`surfaceOp` 非 `'append'`），而非正常追加。 */
function isReplaceSurfaceEvent(event: PetSessionEvent): boolean {
  const op = event.surfaceOp
  return op !== undefined && op !== 'append' && op.op === 'replace'
}

/** `update_goal` 调用声明的收尾动作；`edit`/`pause`/`resume` 不算收尾，参数不可解析时忽略。 */
function goalClosingOf(name: string | undefined, args: string | undefined): PetGoalClosing | undefined {
  if (name !== 'update_goal')
    return undefined
  try {
    const action = (JSON.parse(args ?? '') as { action?: string }).action
    return action === 'complete' || action === 'blocked' ? action : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 回合终局档位：goal 续跑轮的**中间轮**只到 `result`（目标仍在推进，不得播雀跃庆祝）。
 * 非 goal 轮维持 `success`；续跑轮以 `update_goal` 收尾时按收尾动作定档。
 */
function completedStatus(state: PetSessionState): PetWorkStatus {
  if (!state.goalRound)
    return 'success'
  if (state.goalClosing === 'blocked')
    return 'error'
  return state.goalClosing === 'complete' ? 'success' : 'result'
}

/**
 * 从 todo/write 提取当前任务文本。
 *
 * 取**最后一个** in_progress：agent 常把新步骤标 in_progress 却忘标上一步 completed，
 * 取第一个会让文案永远停在最早那步。清单无进行中项时回落第一个 pending。
 *
 * 文案按**码点**截断到 `PET_TASK_TEXT_MAX`（气泡最大宽只有宠物宽的 0.5 倍，长 todo 原文
 * 会把气泡撑成多行）；用 `Array.from` 而非 `slice`，避免劈开代理对或 emoji。
 */
function currentTaskFromTodo(data: Record<string, unknown>): string | undefined {
  const todos = Array.isArray(data.todos) ? (data.todos as Array<{ status?: string, content?: string }>) : []
  const current = todos.findLast(todo => todo?.status === 'in_progress')
    ?? todos.find(todo => todo?.status === 'pending')
  const content = Array.from(String(current?.content ?? '').trim())
  if (!content.length)
    return undefined
  return content.length > PET_TASK_TEXT_MAX
    ? `${content.slice(0, PET_TASK_TEXT_MAX).join('')}…`
    : content.join('')
}

/** 需要 fold+去重的边界事件（增量 chunk 不在其中，防止高频转发）。 */
const FOLDABLE_EVENTS: ReadonlySet<string> = new Set([
  'turn/start',
  'step/start',
  'assistant/message',
  'tool/call',
  'tool/result',
  'user/message',
  'turn/end',
  'session/title',
  'approval/asked',
  'approval/decided',
])

/** 一次会话增量事件的 reducer：返回变化后的 payload 或 null（未变化则不转发）。 */
function reduceSessionEvent(
  state: PetSessionState,
  event: PetSessionEvent,
): PetSessionPayload | null {
  const t = event.type
  const data = event.data ?? {}

  switch (t) {
    case 'turn/start': {
      state.turnActive = true
      state.running = true
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingKind = undefined
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      // 新回合开始：清上一回合的终态错误与任务残留，避免「上一轮报错、本轮继续跑」
      // 时气泡仍按 lastAgentError 判 failed 收起。
      state.lastAgentError = undefined
      state.workStatus = 'thinking'
      state.task = undefined
      break
    }
    case 'step/start':
    case 'assistant/chunk': {
      state.stepActive = true
      state.running = true
      if (t === 'step/start' && !state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      if (t === 'assistant/chunk') {
        // StreamChunk 真实形状：reasoning-delta / text-delta 携带增量 text。
        const chunk = data.chunk as { type?: string, text?: string } | undefined
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
          // 滚动尾部窗口：新内容不断挤掉最早的，气泡即可实时滚动更新。
          state.reasoningTail = (state.reasoningTail + chunk.text).slice(-PET_REASONING_TAIL_WINDOW)
          if (!state.waitingKind && state.openTools.size === 0)
            state.workStatus = 'thinking'
          return foldPetPayload(state)
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text)
          state.assistantText = (state.assistantText + chunk.text).slice(-1000)
        // 其余 chunk 类型（block-start/finish/usage/空帧）只累积状态，不转发。
        return null
      }
      break
    }
    case 'assistant/message': {
      state.stepActive = true
      state.running = true
      const blocks = (data.message as { content?: unknown[] } | undefined)?.content as Array<{ type?: string, text?: string }> | undefined
      const text = blocks?.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
      if (text)
        state.assistantText = text.slice(-1000)
      if (!state.waitingKind && state.openTools.size === 0)
        state.workStatus = 'thinking'
      break
    }
    case 'tool/call': {
      const call = data as { callId?: string, name?: string, arguments?: string }
      const name = call.name
      const closing = goalClosingOf(name, call.arguments)
      if (closing)
        state.goalClosing = closing
      // 携带原始 arguments JSON 字符串，供气泡解析 command/path。
      if (name)
        state.openTools.set(call.callId ?? name, { name, args: call.arguments })
      state.running = true
      if (name && isUserQuestionTool(name)) {
        // 问句工具：等用户回答，展示为「等待中」而非「思考中」。
        state.waitingKind = 'user-question'
        state.waitingCallId = call.callId ?? name
        state.workStatus = 'waiting'
      }
      else {
        if (name)
          state.toolActivity = toolActivityOf(name)
        state.workStatus = 'working'
      }
      break
    }
    case 'tool/result': {
      const callId = toolCallIdOf(event)
      if (callId) {
        state.openTools.delete(callId)
        if (callId === state.waitingCallId) {
          state.waitingKind = undefined
          state.waitingCallId = undefined
        }
      }
      else {
        state.openTools.clear()
      }
      // 工具级失败（data.error）不写入 lastAgentError —— 那是回合级终态语义，写入后气泡会
      // 把仍在跑的回合判为 failed 并收起。回合真正失败由 turn/end(error) 负责记录。
      if (state.openTools.size > 0) {
        state.workStatus = 'working'
        state.toolActivity = toolActivityOf(state.openTools.values().next().value?.name)
      }
      else {
        state.workStatus = state.waitingKind ? 'waiting' : 'result'
      }
      break
    }
    case 'approval/asked': {
      const id = String(data.id ?? '')
      state.waitingKind = 'approval'
      state.waitingApprovalId = id
      state.running = true
      state.workStatus = 'waiting'
      break
    }
    case 'approval/decided': {
      const id = String(data.id ?? '')
      // 与当前记录不匹配：状态未变，不转发。
      if (!state.waitingApprovalId || id !== state.waitingApprovalId)
        return null
      state.waitingApprovalId = undefined
      state.waitingKind = undefined
      // 审批通过后继续干活：还有工具在跑 → working；否则回思考。
      state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      break
    }
    case 'user/message': {
      // 替换标记（rewind 回退 / 压缩 checkpoint）是既有事件区间的记账，不是用户新回合：
      // 它出现在 cancel + waitForAgentIdle 之后，且回合外不再追加 turn/end，若照常置
      // running 会让会话永久停在「思考中」，气泡等不到收敛（回退后消不掉的残留气泡）。
      if (isReplaceSurfaceEvent(event))
        return null
      // 用户消息只标记会话活跃，不写入展示 message（避免把用户提示当成助手描述）。
      if (isGoalRoundEvent(data))
        state.goalRound = true
      state.running = true
      state.turnActive = true
      if (state.waitingCallId !== undefined) {
        state.waitingKind = undefined
        state.waitingCallId = undefined
        state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      }
      break
    }
    case 'todo/write': {
      const task = currentTaskFromTodo(data)
      if (task === state.task)
        return null
      state.task = task
      return foldPetPayload(state)
    }
    case 'session/title': {
      const title = data.title
      if (typeof title === 'string' && title) {
        state.title = title
        state.displayTitle = title
      }
      break
    }
    case 'turn/end': {
      state.turnActive = false
      state.stepActive = false
      state.running = false
      state.openTools.clear()
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      const reason = (data as { reason?: { kind?: string, error?: { message?: string } } }).reason
      if (reason?.kind === 'blocked') {
        // 会话被阻塞等待用户处理：展示为「等待中」。
        state.waitingKind = 'blocked'
        state.workStatus = 'waiting'
      }
      else {
        state.waitingKind = undefined
        if (reason?.kind === 'completed') {
          state.workStatus = completedStatus(state)
          state.lastAgentError = undefined
        }
        else if (reason?.kind === 'error' || reason?.kind === 'max-tokens' || reason?.kind === 'timeout') {
          state.workStatus = 'error'
          state.lastAgentError = reason.error?.message ?? reason.kind
        }
        else {
          // aborted/interrupted/未知：手动取消是用户主动中断而非失败，不得写入
          // lastAgentError（否则气泡下一帧判 failed 弹「失败：aborted」），静默回空闲。
          settleIdle(state)
        }
      }
      // 回合级 goal 标志随回合结束失效：新一轮的 source/update_goal 各自重新声明。
      state.goalRound = false
      state.goalClosing = undefined
      break
    }
    default:
      break
  }

  // 只在「我们关心的变化」边界 fold+去重：assistant/chunk 的增量只做状态累积，
  // 逐 token 转发会产生洪泛（#396 的根因）。
  if (!FOLDABLE_EVENTS.has(t))
    return null

  return foldPetPayload(state)
}

/**
 * 把累计态落定为「回合已收尾、空闲」：清掉回合内的一切瞬时态。
 *
 * `turn/end` 的中断分支与 `agent/status → idle` 兜底共用同一份语义，避免两条收尾路径
 * 漂移出「一条清干净、另一条残留 thinking」这类只在真实中断时复现的差异。
 */
function settleIdle(state: PetSessionState): void {
  state.turnActive = false
  state.stepActive = false
  state.running = false
  state.openTools.clear()
  state.reasoningTail = ''
  state.assistantText = ''
  state.waitingKind = undefined
  state.waitingApprovalId = undefined
  state.waitingCallId = undefined
  state.workStatus = undefined
  state.lastAgentError = undefined
  state.goalRound = false
  state.goalClosing = undefined
}

/** 会话是否仍处于「回合内」（只有这种状态才允许被 idle 兜底改写）。 */
function inTurn(state: PetSessionState): boolean {
  return state.running || state.turnActive || state.stepActive
}

/** 两个 payload 是否深相等（以 fold 出的关键字段表征）。 */
function payloadEqual(a: PetSessionPayload, b: PetSessionPayload): boolean {
  return Object.is(a.status, b.status)
    && Object.is(a.activity, b.activity)
    && Object.is(a.phase, b.phase)
    && Object.is(a.running, b.running)
    && Object.is(a.message, b.message)
    && Object.is(a.lastAgentError, b.lastAgentError)
    && Object.is(a.origin, b.origin)
    && Object.is(a.title, b.title)
    && Object.is(a.displayTitle, b.displayTitle)
    && Object.is(a.workStatus, b.workStatus)
    && Object.is(a.task, b.task)
    && Object.is(a.toolActivity, b.toolActivity)
    && Object.is(a.liveActivity?.kind, b.liveActivity?.kind)
    && Object.is(a.liveActivity?.text, b.liveActivity?.text)
    && Object.is(a.liveActivity?.name, b.liveActivity?.name)
    && Object.is(a.liveActivity?.command, b.liveActivity?.command)
    && Object.is(a.liveActivity?.path, b.liveActivity?.path)
    && Object.is(a.liveActivity?.args, b.liveActivity?.args)
}

/** 工具名 → liveActivity 展示对象（所有工具统一携带 name+args）。 */
function toolActivity(name?: string, args?: string): PetSessionPayload['liveActivity'] {
  return name ? { kind: 'tool', name, args } : { kind: 'tool' }
}

/**
 * 从 tool 事件提取调用 id：`tool/call` 直接给 `data.callId`；`tool/result` 的 callId 藏在
 * `data.message` 里（source.callId / content[].toolCallId / message.toolCallId | callId）。
 */
function toolCallIdOf(event: PetSessionEvent, fallback = ''): string {
  const data = event.data as Record<string, unknown> | undefined
  const message = data?.message as Record<string, unknown> | undefined
  const content = Array.isArray(message?.content)
    ? (message.content as Array<Record<string, unknown>>).find(item => item.toolCallId)
    : undefined
  const callId = (message?.source as { callId?: unknown } | undefined)?.callId
    ?? content?.toolCallId
    ?? message?.toolCallId
    ?? message?.callId
    ?? data?.callId
  return String(callId ?? fallback)
}

/**
 * 判断一个工具名是否是「等用户回答」的问句工具（approval/澄清/确认类），而非普通脚本
 * （避免把 code_review/allowlist_files/permission_scan 误判为等待态）。
 * 按整体 token 匹配（`\b` 不切分 snake_case），而非子串。
 */
function isUserQuestionTool(name?: string): boolean {
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)
  if (!tokens.length)
    return false

  const asks = new Set(['ask', 'asking', 'request', 'requests', 'requesting', 'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions', 'confirmation', 'approval', 'permission', 'authorization', 'authorisation', 'consent', 'clarify', 'clarification', 'help'])

  const hasUserNoun = tokens.some((token, index) =>
    userWords.has(token) && nouns.has(tokens[index + 1] ?? ''),
  )
  const hasNounFromUser = tokens.some((token, index) =>
    nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? ''),
  )
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token))
      return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  const strong = tokens.some(token =>
    token === 'authorize' || token === 'authorise' || token === 'consent',
  )
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode',
  )
  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}
