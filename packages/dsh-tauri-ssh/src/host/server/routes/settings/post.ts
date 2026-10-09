import type { EventHandlerRequest } from 'h3'
import type { SshSettingsBody, SshSettingsResponse } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../service/machine'
import { enabledOf, guarded } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshSettingsResponse>>(async (event) => {
  const body = (await readBody<SshSettingsBody>(event)) ?? {}
  return guarded(event, async () => {
    const enabled = enabledOf(body)
    await machine.setEnabled(enabled)
    return { enabled }
  })
})
