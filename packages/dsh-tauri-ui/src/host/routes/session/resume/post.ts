import type { EventHandlerRequest } from 'dsh-tauri'
import type { SessionResumeResponse } from '../../../types'
import { defineEventHandler, readBody } from 'dsh-tauri'
import { session } from '../../../service/session'

export default defineEventHandler<EventHandlerRequest, Promise<SessionResumeResponse>>(async (event) => {
  const body = (await readBody<{ sessionId?: string }>(event)) ?? {}
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  const outcome = await session.resume(sessionId)
  if (outcome.ok)
    return { ok: true }
  event.res.status = outcome.code
  if ('refusal' in outcome)
    return { error: outcome.error, refusal: outcome.refusal }
  return { error: outcome.error }
})
