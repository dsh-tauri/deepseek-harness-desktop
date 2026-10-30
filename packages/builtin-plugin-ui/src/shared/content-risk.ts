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
  startSeq: number
  endSeq: number
  shadowedSeqs: number[]
  watermarkSeq: number
}

const CONTENT_REJECTED = 'CONTENT_REJECTED'
const INVALID_REQUEST = 'INVALID_REQUEST'
const REFUSAL_MESSAGE = 'Content Exists Risk'

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

export function eventOf(value: unknown): SessionEventLike | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const record = value as { event?: unknown }
  const event = record.event ?? value
  return typeof event === 'object' && event !== null ? event as SessionEventLike : undefined
}

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

export function isContentRiskTurnEnd(values: readonly unknown[] | undefined): boolean {
  return isContentRiskFailure(lastTurnEndReason(values)?.error)
}

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
