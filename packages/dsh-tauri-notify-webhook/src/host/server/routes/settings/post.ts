import type { EventHandlerRequest } from 'h3'
import type { PostSettingsBody, PostSettingsResult } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { settings } from '../../../service/settings'
import { deliveryErrorOf } from '../../../utils/error'

export default defineEventHandler<EventHandlerRequest, Promise<PostSettingsResult>>(async (event) => {
  const body = await readBody<PostSettingsBody>(event).catch(() => undefined)
  if (body?.settings === undefined)
    return { error: 'NOTIFY_INVALID: settings' }
  try {
    return { settings: await settings.save(body.settings) }
  }
  catch (error) {
    return { error: deliveryErrorOf(error) }
  }
})
