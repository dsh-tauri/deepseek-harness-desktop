import type { EventHandlerRequest } from 'h3'
import type { NativeModelDirectory } from '../../../../shared/native-model'
import { defineEventHandler, getQuery, HTTPError } from 'h3'
import { model } from '../../../service/model'

export default defineEventHandler<EventHandlerRequest, Promise<NativeModelDirectory>>((event) => {
  const query = getQuery<{ sessionId: string }>(event)
  if (typeof query.sessionId !== 'string' || !query.sessionId.trim())
    throw new HTTPError({ statusCode: 400, message: 'BRIDGE_SESSION_INVALID: 请指定原生会话。' })
  return model.getCatalog(query.sessionId)
})
