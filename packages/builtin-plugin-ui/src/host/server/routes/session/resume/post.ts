import type { EventHandlerRequest } from 'h3'
import type { SessionResumeResponse } from '../../../../types'
import type { SessionResumeBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { session } from '../../../../service/session'

export default defineEventHandler<EventHandlerRequest, Promise<SessionResumeResponse>>(async (event) => {
  const body = (await readBody<SessionResumeBody>(event)) ?? {}
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  const outcome = await session.resume(sessionId)
  if (outcome.ok)
    return { ok: true }
  event.res.status = outcome.code
  return { error: outcome.error }
})
