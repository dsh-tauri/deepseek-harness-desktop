import type { EventHandlerRequest } from 'h3'
import type { GetSettingsResult } from '../index.types'
import { defineEventHandler } from 'h3'
import { settings } from '../../../service/settings'
import { deliveryErrorOf } from '../../../utils/error'

export default defineEventHandler<EventHandlerRequest, Promise<GetSettingsResult>>(async () => {
  try {
    return { settings: await settings.load() }
  }
  catch (error) {
    return { error: deliveryErrorOf(error) }
  }
})
