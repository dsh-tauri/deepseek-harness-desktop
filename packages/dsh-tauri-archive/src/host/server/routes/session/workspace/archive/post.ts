import type { WorkspaceArchiveBody } from '../../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { archive } from '../../../../../service/archive'
import { validateSessionIds } from '../../../index.utils'

export default defineEventHandler(async (event) => {
  const body = await readBody<WorkspaceArchiveBody>(event, { type: 'json' })
  const sessionIds = validateSessionIds(event, body)
  return Array.isArray(sessionIds) ? archive.archiveWorkspace(sessionIds) : sessionIds
})
