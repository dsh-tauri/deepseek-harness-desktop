import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import type { RemoteTunnelMode } from '../../../../types/index'
import { defineEventHandler, readBody } from 'h3'
import { access } from '../../../../service/access'
import { tunnel } from '../../../../service/tunnel'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async event =>
  guarded(event, async () => {
    const body = (await readBody<{ mode?: unknown, token?: unknown, hostname?: unknown }>(event)) ?? {}
    await tunnel.start(modeOf(body.mode), textOf(body.token, 'token'), textOf(body.hostname, 'hostname'))
    return await access.status()
  }))

// --- internal ---
function modeOf(value: unknown): RemoteTunnelMode {
  if (value === 'quick' || value === 'token')
    return value
  throw new Error('invalid mode: quick | token')
}

function textOf(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string')
    throw new Error(`invalid ${field}`)
  return value
}
