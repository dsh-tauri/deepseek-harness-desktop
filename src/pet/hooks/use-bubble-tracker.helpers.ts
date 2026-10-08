import type { Motion } from 'dsh-pet-component'
import {
  ACTIVE_MOTIONS,
  ACTIVITY_COPY,
  pickLang,
  SESSION_LABELS,
  STATUS_COPY,
  STATUS_TEXT_MAP,
  TOOL_ARG_KEYS,
  TOOL_LABELS,
  TOOL_PATTERNS,
  UNTITLED_SESSION_TITLE,
  WORK_STATUSES,
} from './use-bubble-tracker.constants'

export interface SessionTitleSource {
  [key: string]: unknown
  title?: unknown
  displayTitle?: unknown
  name?: unknown
  phase?: unknown
  origin?: unknown
}

export interface BubbleSession {
  [key: string]: unknown
  id: string
}

/** seed → 稳定非负整数 */
export function seedNumber(seed: string | number | undefined): number {
  const value = String(seed ?? '')
  const numeric = Number(value)
  if (Number.isFinite(numeric))
    return Math.abs(Math.trunc(numeric))
  return [...value].reduce((total, char) => total + (char.codePointAt(0) ?? 0), 0)
}

function selectCopy(variants: readonly string[], seed?: string | number): string {
  return variants[seedNumber(seed) % variants.length] ?? variants[0]
}

export function statusCopy(group: string, seed?: string | number): string {
  return selectCopy(STATUS_COPY[group] ?? STATUS_COPY.working, seed)
}

export function activityCopy(activity: string, seed?: string | number): string {
  return selectCopy(ACTIVITY_COPY[activity] ?? STATUS_COPY.working, seed)
}

export function taskCopy(task: string | undefined): string | undefined {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value)
    return undefined
  if (/^(?:正在|继续)/u.test(value))
    return value
  if (/^(?:准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现)/u.test(value))
    return `正在${value}`
  return `正在处理「${value}」`
}

export function toolActivityGroup(tool: string | undefined): string {
  const value = String(tool || '').toLowerCase()
  return TOOL_PATTERNS.find(([pattern]) => pattern.test(value))?.[1] ?? 'working'
}

export function sessionTitle(session: SessionTitleSource): string {
  const base = [session.title, session.displayTitle, session.name]
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
    ?.trim() ?? UNTITLED_SESSION_TITLE

  if (session.phase === 'approval')
    return `${SESSION_LABELS.waitApproval} · ${base}`
  if (session.phase === 'user-question' || session.phase === 'blocked')
    return `${SESSION_LABELS.waitChoice} · ${base}`
  if (session.origin === 'subagent')
    return `${SESSION_LABELS.subagent} · ${base}`
  return base
}

export function rawSession(payload: unknown): BubbleSession | undefined {
  if (!payload || typeof payload !== 'object')
    return undefined
  const record = payload as Record<string, unknown>
  const session = (record.session && typeof record.session === 'object' ? record.session : record) as Record<string, unknown>
  const id = session.id ?? session.sessionId
  return typeof id === 'string' && id.length > 0 ? { ...session, id } : undefined
}

export function sessionMotion(session: BubbleSession): Motion | undefined {
  const work = session.workStatus as string
  if (WORK_STATUSES.has(work))
    return work as Motion

  const value = session.status ?? session.activity ?? session.phase
  const agentError = session.lastAgentError

  if (session.running !== true && (value === 'failed' || value === 'error' || (Boolean(agentError) && agentError !== 'aborted'))) {
    return 'failed'
  }
  if (value === 'review' || value === 'reviewing' || value === 'plan-review')
    return 'review'

  const hasPending = Array.isArray(session.pending) ? session.pending.length > 0 : Boolean(session.pending)
  if (value === 'waiting' || value === 'pending' || value === 'blocked' || Boolean(session.pendingInteraction) || hasPending) {
    return 'waiting'
  }
  if (value === 'running' || value === 'working' || value === 'thinking' || session.running === true) {
    return 'running'
  }

  return undefined
}

function sanitizeText(str: string): string {
  return str.replace(/\s+/g, ' ').trim()
}

function toolArgDetail(tool: string, args: unknown): string | undefined {
  if (typeof args !== 'string' || !args)
    return undefined
  try {
    const record = JSON.parse(args)
    if (!record || typeof record !== 'object' || Array.isArray(record))
      return undefined

    const keys = TOOL_ARG_KEYS[tool] ?? ['file_path', 'path']
    for (const key of keys) {
      const val = record[key]
      if (typeof val === 'string' && val.trim())
        return sanitizeText(val)
      if (Array.isArray(val)) {
        const first = val.find(item => typeof item === 'string' && item.trim())
        if (first)
          return sanitizeText(first)
      }
    }
  }
  catch {
    /* 忽略非合法 JSON */
  }
  return undefined
}

export function getLiveActivity(session: BubbleSession, motion: Motion): string | undefined {
  if (!ACTIVE_MOTIONS.has(motion) || !session.liveActivity || typeof session.liveActivity !== 'object') {
    return undefined
  }
  const { kind, text, name, args } = session.liveActivity as Record<string, unknown>

  if (kind === 'reasoning' && typeof text === 'string' && text.trim()) {
    return pickLang(`思考 · ${sanitizeText(text)}`, `Thought · ${sanitizeText(text)}`)
  }
  if (kind === 'tool' && typeof name === 'string' && name) {
    const tool = name.toLowerCase()
    const label = TOOL_LABELS[tool]
    if (!label)
      return pickLang(`工具调用 · ${name}`, `Tool · ${name}`)
    const detail = toolArgDetail(tool, args)
    return detail ? `${label} · ${detail}` : label
  }
  return undefined
}

export function bubbleContent(session: BubbleSession, motion: Motion) {
  const isSub = session.origin === 'subagent'
  const title = sessionTitle(session)
  const seed = session.id

  const statusText = STATUS_TEXT_MAP[motion]
    ?? (motion === 'running'
      ? (isSub ? pickLang('运行中', 'Running') : pickLang('思考中', 'Thinking'))
      : pickLang('空闲', 'Idle'))

  const fallbackCopy = motion === 'waiting'
    ? statusCopy(session.phase === 'approval' ? 'approval' : 'waiting', seed)
    : motion === 'working'
      ? activityCopy(toolActivityGroup(String((session.liveActivity as Record<string, unknown> | undefined)?.name ?? '')), seed)
      : statusCopy(motion, seed)

  const candidates = [
    session.lastAgentError ? pickLang(`失败：${String(session.lastAgentError)}`, `Failed: ${String(session.lastAgentError)}`) : undefined,
    taskCopy(session.task as string | undefined),
    getLiveActivity(session, motion),
    fallbackCopy,
    session.description,
    session.message,
    statusText,
  ]

  const description = candidates
    .find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    ?.trim() ?? pickLang('会话', 'Session')

  return {
    title,
    description,
    loading: ACTIVE_MOTIONS.has(motion),
  }
}
