import type { SessionIdsBody } from '../../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { archive } from '../../../../../service/archive'
import { validateSessionIds } from '../../../index.utils'

export default defineEventHandler(async (event) => {
  const body = await readBody<SessionIdsBody>(event, { type: 'json' })
  const sessionIds = validateSessionIds(event, body)
  return Array.isArray(sessionIds) ? archive.deleteSelected(sessionIds) : sessionIds
})
