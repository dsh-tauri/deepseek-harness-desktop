import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import type { RemoteTunnelMode } from '../../../../types/index'
import type { RemoteAccessTunnelBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { access } from '../../../../service/access'
import { tunnel } from '../../../../service/tunnel'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async (event) => {
  const body = (await readBody<RemoteAccessTunnelBody>(event)) ?? {}
  return await guarded(event, async () => {
    const mode = modeOf(body.mode)
    const credential = textOf(body.token, 'token')
    const host = textOf(body.hostname, 'hostname')
    tunnel.assertStartable(mode, credential, host)
    await access.ensureAuth()
    await tunnel.start(mode, credential, host)
    return await access.status()
  })
})

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
