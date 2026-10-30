import type { H3Event } from 'h3'
import type { SessionIdBody, SessionIdsBody } from './index.types'

export function validateSessionId(event: H3Event, body: SessionIdBody | null | undefined) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId.length > 0)
    return sessionId
  event.res.status = 400
  return { ok: false as const, error: 'invalid-session-id' }
}

export function validateSessionIds(event: H3Event, body: SessionIdsBody | null | undefined) {
  const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.map(String).filter(Boolean) : []
  if (sessionIds.length > 0)
    return sessionIds
  event.res.status = 400
  return { ok: false as const, error: 'invalid-session-ids' }
}
