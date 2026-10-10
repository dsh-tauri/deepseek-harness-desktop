import type { EventHandlerRequest } from 'h3'
import type { CreateBody } from '../../../types'
import { defineEventHandler, HTTPError, readBody } from 'h3'
import { session } from '../../../service/session'

export default defineEventHandler<EventHandlerRequest, Promise<{ sessionId: string }>>(async (event) => {
  const body = await readBody<CreateBody>(event)
  if (body === null || typeof body !== 'object' || (body.backend !== 'codex' && body.backend !== 'claude'))
    throw new HTTPError({ statusCode: 400, message: 'BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。' })
  for (const key of ['workspaceId', 'cwd', 'agentPreset'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim()))
      throw new HTTPError({ statusCode: 400, message: `BRIDGE_REQUEST_INVALID: ${key}` })
  }
  if (body.workspaceId !== undefined && body.cwd !== undefined)
    throw new HTTPError({ statusCode: 400, message: 'BRIDGE_LOCATION_INVALID: workspaceId 与 cwd 不能同时指定。' })
  return session.create(body.backend, body.workspaceId, body.cwd, body.agentPreset)
})
