/**
 * 内容审核失败（Content Exists Risk）的识别与恢复边界计算。
 *
 * 宿主与客户端共用同一判定：客户端据此改写主按钮文案，宿主据此决定是否遮蔽
 * 失败回合。两侧若各写一份，就会出现「按钮说能恢复、宿主却按普通继续重放被拒
 * 上下文」的分叉——那正是本模块要消灭的缺陷。
 */

/** 内核 `LlmFailure` 的相关字段；未识别的形态一律按「不是审核失败」处理。 */
export interface ContentRiskFailureLike {
  code?: unknown
  message?: unknown
  status?: unknown
}

export interface TurnEndReasonLike {
  kind?: unknown
  error?: unknown
}

export interface SessionEventLike {
  seq?: unknown
  type?: unknown
  data?: unknown
}

export interface ContentRiskRecoveryRange {
  /** 遮蔽区间首节点，必须仍是当前 surface 节点。 */
  startSeq: number
  /** 遮蔽区间末节点，必须仍是当前 surface 节点。 */
  endSeq: number
  /** 被遮蔽的每个节点 seq，逐字进 `sourceEventSeqs`（内核要求完整覆盖）。 */
  shadowedSeqs: number[]
  /**
   * 最新失败回合 `turn/end` 的 seq，会话日志回传水位必须推到这里。
   *
   * 表面遮蔽只改模型可见历史：`dsh_session_log` 按单一水位回传水位之后的**原始**事件，
   * 其中 `agent/inbox/spliced` 逐字复制了用户输入、工具结果也在其内——被拒文本因此仍会
   * 到达上游并再次触发同一条拒绝。水位是单值游标（无法挖洞），故只能整段推进到失败回合末尾。
   */
  watermarkSeq: number
}

const CONTENT_REJECTED = 'CONTENT_REJECTED'
const INVALID_REQUEST = 'INVALID_REQUEST'
const REFUSAL_MESSAGE = 'Content Exists Risk'

/**
 * 上游给专用码时直接用码；DeepSeek 网关只回 400 + 原文消息，故保留消息兼容路径。
 * 未知的 400 / INVALID_REQUEST 一律不算审核失败——误判会静默改写用户上下文。
 */
export function isContentRiskFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null)
    return false
  const failure = value as ContentRiskFailureLike
  if (failure.code === CONTENT_REJECTED)
    return true
  if (failure.status !== undefined && failure.status !== 400)
    return false
  return failure.code === INVALID_REQUEST
    && typeof failure.message === 'string'
    && failure.message.trim() === REFUSAL_MESSAGE
}

/** 事件条目既可能是裸事件，也可能是 `{ event }` 包裹（客户端快照的形态）。 */
export function eventOf(value: unknown): SessionEventLike | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const record = value as { event?: unknown }
  const event = record.event ?? value
  return typeof event === 'object' && event !== null ? event as SessionEventLike : undefined
}

/** 最新一条 `turn/end` 的 reason；读不到日志或没有结束事件时返回 undefined。 */
export function lastTurnEndReason(values: readonly unknown[] | undefined): TurnEndReasonLike | undefined {
  if (values === undefined)
    return undefined
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const event = eventOf(values[index])
    if (event?.type !== 'turn/end')
      continue
    const reason = (event.data as { reason?: unknown } | undefined)?.reason
    return typeof reason === 'object' && reason !== null ? reason as TurnEndReasonLike : undefined
  }
  return undefined
}

/** 最新一轮是否因内容审核被拒——客户端只凭它决定按钮文案。 */
export function isContentRiskTurnEnd(values: readonly unknown[] | undefined): boolean {
  return isContentRiskFailure(lastTurnEndReason(values)?.error)
}

/**
 * 从「最后一个审核失败回合」往前，取连续失败回合的最早 `turn/start` 作为安全边界，
 * 边界之后的全部 surface 节点都要被遮蔽。
 *
 * 语义依据（issue #928）：触发内容在同一回合内产生（工具结果 → 下一次请求立刻 400），
 * 因此整回合遮蔽即安全，更早的成功上下文必须保留。
 *
 * 返回 undefined 表示无法给出安全边界——调用方必须拒绝自动继续，绝不回放。
 */
export function contentRiskRecoveryRange(input: {
  events: readonly unknown[]
  nodes: readonly number[]
}): ContentRiskRecoveryRange | undefined {
  const failingTurns = new Set<number>()
  let earliestTurnStart: number | undefined
  let newestRefusedEnd: number | undefined
  let sawFailure = false
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = eventOf(input.events[index])
    const data = event?.data as { turn?: unknown, reason?: unknown } | undefined
    if (event?.type === 'turn/end') {
      if (!isContentRiskFailure(data?.reason && (data.reason as TurnEndReasonLike).error)) {
        if (sawFailure)
          break
        return undefined
      }
      sawFailure = true
      // 倒序扫描遇到的第一个 turn/end 就是最新失败回合——它决定回传水位。
      if (newestRefusedEnd === undefined && typeof event.seq === 'number')
        newestRefusedEnd = event.seq
      if (typeof data?.turn === 'number')
        failingTurns.add(data.turn)
      continue
    }
    if (event?.type === 'turn/start' && typeof data?.turn === 'number' && failingTurns.has(data.turn)) {
      const seq = typeof event.seq === 'number' ? event.seq : undefined
      if (seq !== undefined)
        earliestTurnStart = seq
    }
  }
  if (!sawFailure || earliestTurnStart === undefined || newestRefusedEnd === undefined)
    return undefined
  const boundary = earliestTurnStart - 1
  let candidates = input.nodes.filter(seq => seq > boundary)
  // 首个 surface 节点落在被遮蔽区间内时一律丢弃：内核只允许 system/message 重写 node 0，
  // 而该节点本就在失败回合里，遮蔽它既安全又必需。
  if (candidates.length > 0 && candidates[0] === input.nodes[0])
    candidates = candidates.slice(1)
  if (candidates.length === 0)
    return undefined
  return {
    startSeq: candidates[0],
    endSeq: candidates[candidates.length - 1],
    shadowedSeqs: candidates,
    watermarkSeq: newestRefusedEnd,
  }
}
