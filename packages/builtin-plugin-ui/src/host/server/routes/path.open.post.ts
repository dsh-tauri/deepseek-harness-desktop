import type { EventHandlerRequest } from 'h3'
import type { OpenPathResult } from '../../service/path.types'
import type { PathBody } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { pathService } from '../../service/path'

export default defineEventHandler<EventHandlerRequest, Promise<OpenPathResult>>(async (event) => {
  const body = await readBody<PathBody>(event, { type: 'json' })
  const result = await pathService.openDirectory(typeof body?.path === 'string' ? body.path.trim() : '')
  if (!result.ok)
    event.res.status = 400
  return result
})
