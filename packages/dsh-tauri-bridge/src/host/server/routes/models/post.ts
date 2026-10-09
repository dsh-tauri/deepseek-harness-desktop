import type { EventHandlerRequest } from 'h3'
import type { NativeTurnOptions } from '../../../../shared/native-model'
import type { ModelBody } from '../../../types'
import { defineEventHandler, HTTPError, readBody } from 'h3'
import { model } from '../../../service/model'

export default defineEventHandler<EventHandlerRequest, Promise<NativeTurnOptions>>(async (event) => {
  const body = await readBody<ModelBody>(event)
  if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string' || !body.sessionId.trim())
    throw new HTTPError({ statusCode: 400, message: 'BRIDGE_SESSION_INVALID: 请指定原生会话。' })
  for (const key of ['model', 'reasoningEffort'] as const) {
    if (body[key] !== null && (typeof body[key] !== 'string' || !body[key].trim()))
      throw new HTTPError({ statusCode: 400, message: `BRIDGE_MODEL_INVALID: ${key}` })
  }
  return model.select(body.sessionId, { model: body.model, reasoningEffort: body.reasoningEffort })
})
