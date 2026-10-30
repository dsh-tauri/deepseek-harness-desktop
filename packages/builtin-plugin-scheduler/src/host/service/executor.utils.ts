import type { RunStatus } from '../types'
import { compact, filter, findLast, last, map } from 'lodash-es'

export const SCHEDULER_TURN_START_TIMEOUT_MS = 30_000

const TURN_START_POLL_MS = 10

export interface RunFailure {
  code: string
  message: string
}

export async function waitForTurnStart(
  session: { seq: number },
  firstSeq: number,
  timeoutMs = SCHEDULER_TURN_START_TIMEOUT_MS,
): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs
  while (session.seq <= firstSeq) {
    if (Date.now() >= deadlineAt)
      return false
    await new Promise(resolve => setTimeout(resolve, TURN_START_POLL_MS))
  }
  return true
}

function reasonOf(reason: Record<string, unknown>): Record<string, unknown> {
  const nested = reason.error
  return typeof nested === 'object' && nested !== null ? nested as Record<string, unknown> : {}
}

export function describeFailure(reason: Record<string, unknown> | undefined): RunFailure {
  if (!reason)
    return { code: 'no_turn_result', message: '本次定时任务没有产生完整 turn。' }
  if (reason.kind === 'error') {
    const error = reasonOf(reason)
    return {
      code: typeof error.code === 'string' ? error.code : 'agent_error',
      message: typeof error.message === 'string' ? error.message : '定时任务 Agent 执行失败。',
    }
  }
  return { code: `turn_${String(reason.kind)}`, message: `定时任务以 ${String(reason.kind)} 结束。` }
}

export function decideRunOutcome(input: {
  started: boolean
  timedOut: boolean
  reason: Record<string, unknown> | undefined
}): { status: RunStatus, error?: RunFailure } {
  if (input.timedOut)
    return { status: 'failed', error: { code: 'timeout', message: '定时任务超过最大运行时限。' } }
  if (!input.started)
    return { status: 'failed', error: describeFailure(undefined) }
  if (input.reason === undefined || input.reason.kind === 'completed')
    return { status: 'succeeded' }
  return { status: 'failed', error: describeFailure(input.reason) }
}

export interface SessionEventLike {
  readonly seq?: number
  readonly type: string
  readonly data: Record<string, any>
}

export interface SessionEventWatch {
  readonly events: SessionEventLike[]
  stop: () => void
}

const SUMMARY_EVENT_TYPES = new Set(['turn/start', 'assistant/message', 'turn/end'])

export function watchSessionEvents(
  ctx: { on?: (name: string, listener: (...args: any[]) => void) => () => void },
  session: unknown,
  fromSeq: number,
): SessionEventWatch {
  const events: SessionEventLike[] = []
  const stop = typeof ctx.on === 'function'
    ? ctx.on('session/event', (target: unknown, event: SessionEventLike) => {
        if (target !== session || typeof event?.type !== 'string')
          return
        if (!SUMMARY_EVENT_TYPES.has(event.type))
          return
        if (typeof event.seq === 'number' && event.seq < fromSeq)
          return
        events.push(event)
      })
    : () => {}
  return { events, stop }
}

export function summarizeRun(session: unknown, firstSeq: number): {
  readonly text: string
  readonly reason?: Record<string, any>
} {
  return summarizeEvents(sessionEvents(session), firstSeq)
}

export function summarizeCollectedRun(
  live: readonly SessionEventLike[],
  session: unknown,
  firstSeq: number,
): ReturnType<typeof summarizeRun> {
  const fromLive = summarizeEvents(live, firstSeq)
  if (fromLive.reason !== undefined)
    return fromLive
  return summarizeRun(session, firstSeq)
}

function summarizeEvents(events: readonly SessionEventLike[], firstSeq: number): {
  readonly text: string
  readonly reason?: Record<string, any>
} {
  const scoped = filter(events, event => typeof event.seq !== 'number' || event.seq >= firstSeq)
  const texts = compact(map(filter(scoped, { type: 'assistant/message' }), textOf))
  const reason = findLast(scoped, { type: 'turn/end' })?.data.reason as Record<string, any> | undefined
  return { text: last(texts) ?? '', ...(reason ? { reason } : {}) }
}

export function isPluginUnloadError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { readonly code?: unknown }).code === 'INACTIVE_EFFECT'
}

function sessionEvents(value: unknown): readonly SessionEventLike[] {
  if (typeof value !== 'object' || value === null)
    return []
  const session = value as Record<string, unknown>
  const snapshotEvents = session.snapshotEvents
  if (typeof snapshotEvents === 'function') {
    const snapshot: unknown = Reflect.apply(snapshotEvents, value, [])
    if (Array.isArray(snapshot))
      return snapshot as readonly SessionEventLike[]
  }
  return []
}

function textOf(event: SessionEventLike): string {
  const blocks = (event.data.message?.content ?? []) as readonly { type: string, text?: string }[]
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}
