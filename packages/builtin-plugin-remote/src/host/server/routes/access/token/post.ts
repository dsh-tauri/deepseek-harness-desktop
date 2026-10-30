import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import { defineEventHandler } from 'h3'
import { access } from '../../../../service/access'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async event =>
  guarded(event, async () => await access.rotate()))
