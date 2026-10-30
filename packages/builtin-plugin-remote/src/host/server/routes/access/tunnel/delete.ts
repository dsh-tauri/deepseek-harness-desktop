import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import { defineEventHandler } from 'h3'
import { access } from '../../../../service/access'
import { tunnel } from '../../../../service/tunnel'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async (event) => {
  return await guarded(event, async () => {
    await tunnel.stop()
    return await access.status()
  })
})
