import type { EventHandlerRequest } from 'h3'
import type { IncomingMessage } from 'node:http'
import type { RemoteAccessStatus } from '../../../service/access.types'
import { defineEventHandler } from 'h3'
import { sourceSessionToken } from '../../../config/runtime'
import { access } from '../../../service/access'
import { redactStatus } from '../../../service/access.utils'
import { isLoopbackSource } from '../../../utils/source'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus>>(async (event) => {
  const status = await access.status()
  const request = (event.runtime as { node?: { req?: IncomingMessage } } | undefined)?.node?.req
  return request !== undefined && isLoopbackSource(request.headers, request.socket?.remoteAddress, sourceSessionToken())
    ? status
    : redactStatus(status)
})
