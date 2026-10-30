import type { EventHandlerRequest } from 'h3'
import type { OpenModelsConfigResponse } from '../../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { configFile } from '../../../../service/config-file'

export default defineEventHandler<EventHandlerRequest, Promise<OpenModelsConfigResponse>>(async (event) => {
  const query = getQuery<{ dry?: string }>(event)
  if (query.dry === '1') {
    const resolved = await configFile.resolve()
    return { ok: true, path: resolved.path }
  }
  const result = await configFile.open()
  if (!result.ok) {
    event.res.status = 500
    return { ok: false, path: result.path, error: result.error }
  }
  return { ok: true, path: result.path, opened: result.opened }
})
