import type { EventHandlerRequest } from 'h3'
import type { RemoteCoreSwitchBody, RemoteCoreTaskAcceptedResponse } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { core } from '../../service/core'
import { coreSlotKeyOf, guarded, machineIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreTaskAcceptedResponse>>(async (event) => {
  const body = (await readBody<RemoteCoreSwitchBody>(event)) ?? {}
  return guarded(event, async () => {
    return await core.switchVersion(machineIdOf(body), coreSlotKeyOf(body))
  })
})
