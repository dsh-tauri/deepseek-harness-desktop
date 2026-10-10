import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessBody, RemoteAccessStatus } from '../../../service/access.types'
import { defineEventHandler, readBody } from 'h3'
import { access } from '../../../service/access'
import { guarded } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async event =>
  guarded(event, async () => {
    const body = (await readBody<RemoteAccessBody>(event)) ?? {}
    return await access.apply(body)
  }))
