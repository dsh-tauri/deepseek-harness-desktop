import type { EventHandlerRequest } from 'h3'
import type { DeliveryOutcome } from '../../../types/index'
import { defineEventHandler, readBody } from 'h3'
import { notifier } from '../../../service/notifier'

interface PostDeliveryBody {
  sessionId?: string
  title?: string
  trigger?: string
}

export default defineEventHandler<EventHandlerRequest, Promise<DeliveryOutcome>>(async (event) => {
  const body = await readBody<PostDeliveryBody>(event).catch(() => undefined)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId.length === 0)
    return { ok: false, error: 'NOTIFY_INVALID: sessionId' }
  if (body?.trigger !== 'completed' && body?.trigger !== 'abnormal')
    return { ok: false, error: 'NOTIFY_INVALID: trigger' }
  return notifier.deliver(sessionId, typeof body?.title === 'string' ? body.title : '', body.trigger)
})
