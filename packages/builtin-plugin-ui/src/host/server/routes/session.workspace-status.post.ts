import type { EventHandlerRequest } from 'h3'
import type { SessionDirectoryStatus } from '../../service/path.types'
import type { SessionIdBody } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { pathService } from '../../service/path'

export default defineEventHandler<EventHandlerRequest, Promise<SessionDirectoryStatus>>(async (event) => {
  const body = await readBody<SessionIdBody>(event, { type: 'json' })
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { status: 'unknown' }
  }
  return pathService.resolveSessionDirectory(sessionId)
})
