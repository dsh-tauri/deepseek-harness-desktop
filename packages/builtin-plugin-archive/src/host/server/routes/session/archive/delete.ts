import type { SessionIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { archive } from '../../../../service/archive'
import { validateSessionId } from '../../index.utils'

export default defineEventHandler(async (event) => {
  const body = await readBody<SessionIdBody>(event, { type: 'json' })
  const sessionId = validateSessionId(event, body)
  return typeof sessionId === 'string' ? archive.delete(sessionId) : sessionId
})
