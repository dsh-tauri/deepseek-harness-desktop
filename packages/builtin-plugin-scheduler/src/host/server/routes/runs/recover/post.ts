import type { EventHandlerRequest } from 'h3'
import type { ActionResult } from '../../index.types'
import { defineEventHandler } from 'h3'
import { recovery } from '../../../../service/recovery'

export default defineEventHandler<EventHandlerRequest, Promise<ActionResult>>(async () => {
  await recovery.recover()
  return { ok: true }
})
