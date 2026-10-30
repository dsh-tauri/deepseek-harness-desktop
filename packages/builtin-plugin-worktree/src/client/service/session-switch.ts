import type { InputActions, InputSessions, ListSessions, SwitchOutcome, SwitchSessions, Wait } from './session-switch.types'
import { SESSION_SWITCH_MAX_ATTEMPTS, SESSION_SWITCH_RETRY_DELAY_MS } from '../constants'

interface ListWaitInput {
  sessions: ListSessions
  sessionId: string
  wait: Wait
  attempts?: number
  delayMs?: number
}

interface InputWaitInput {
  sessions: InputSessions
  sessionId: string
  wait: Wait
  attempts?: number
  delayMs?: number
}

export async function waitForSessionListed(input: ListWaitInput): Promise<void> {
  const attempts = input.attempts ?? SESSION_SWITCH_MAX_ATTEMPTS
  const delayMs = input.delayMs ?? SESSION_SWITCH_RETRY_DELAY_MS
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (input.sessions.list.getSnapshot().ids.includes(input.sessionId))
      return
    await input.sessions.refresh().catch(() => {})
    await input.wait(delayMs)
  }
  throw new Error('新工作树会话尚未就绪')
}

export async function waitForInputActions(input: InputWaitInput): Promise<InputActions> {
  const attempts = input.attempts ?? SESSION_SWITCH_MAX_ATTEMPTS
  const delayMs = input.delayMs ?? SESSION_SWITCH_RETRY_DELAY_MS
  for (let attempt = 0; attempt < attempts; attempt++) {
    const actions = input.sessions.provideInfo?.(input.sessionId)?.props?.inputActions
    if (actions)
      return actions
    await input.wait(delayMs)
  }
  throw new Error('新工作树会话的输入服务尚未就绪')
}

export async function openSession(input: {
  sessions: SwitchSessions
  sessionId: string
  wait: Wait
  attempts?: number
  delayMs?: number
}): Promise<boolean> {
  const attempts = input.attempts ?? SESSION_SWITCH_MAX_ATTEMPTS
  const delayMs = input.delayMs ?? SESSION_SWITCH_RETRY_DELAY_MS
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      input.sessions.open(input.sessionId)
      if (input.sessions.list.getSnapshot().current === input.sessionId)
        return true
    }
    catch {
      await input.sessions.refresh().catch(() => {})
    }
    await input.wait(delayMs)
  }
  return false
}

export async function switchSession(input: {
  sessions: SwitchSessions
  sourceSessionId: string
  targetSessionId: string
}): Promise<SwitchOutcome> {
  const { sessions, sourceSessionId, targetSessionId } = input
  const snapshot = sessions.list.getSnapshot()
  if (snapshot.current === targetSessionId)
    return 'switched'
  if (snapshot.current !== sourceSessionId)
    return 'aborted'

  if (!snapshot.ids.includes(targetSessionId)) {
    await sessions.refresh().catch(() => {})
    const refreshed = sessions.list.getSnapshot()
    if (refreshed.current === targetSessionId)
      return 'switched'
    if (refreshed.current !== sourceSessionId)
      return 'aborted'
    if (!refreshed.ids.includes(targetSessionId))
      return 'retry'
  }

  try {
    sessions.open(targetSessionId)
  }
  catch {
    await sessions.refresh().catch(() => {})
  }
  return sessions.list.getSnapshot().current === targetSessionId ? 'switched' : 'retry'
}
