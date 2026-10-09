import type { EventHandlerRequest } from 'h3'
import type { ActionResult, IdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { scheduler } from '../../../../service/scheduler'

export default defineEventHandler<EventHandlerRequest, Promise<ActionResult>>(async (event) => {
  const body = await readBody<IdBody>(event)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (id.length === 0) {
    event.res.status = 400
    return { error: '缺少任务 id' }
  }
  const result = await scheduler.trigger(id)
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return { ok: true }
})
