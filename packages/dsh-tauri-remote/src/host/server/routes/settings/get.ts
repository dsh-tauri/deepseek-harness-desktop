import type { EventHandlerRequest } from 'h3'
import type { RemoteSettingsResponse } from '../index.types'
import { defineEventHandler } from 'h3'
import { machine } from '../../../service/machine'
import { guarded } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteSettingsResponse>>(async event =>
  guarded(event, async () => ({ enabled: machine.enabled() })))
