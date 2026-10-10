import type { EventHandlerRequest } from 'h3'
import type { RemoteSettingsBody, RemoteSettingsResponse } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../service/machine'
import { enabledOf, guarded } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteSettingsResponse>>(async (event) => {
  const body = (await readBody<RemoteSettingsBody>(event)) ?? {}
  return guarded(event, async () => {
    const enabled = enabledOf(body)
    await machine.setEnabled(enabled)
    return { enabled }
  })
})
