import type { EventHandlerRequest } from 'h3'
import type { RemoteConnectResponse, RemoteMachineIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteConnectResponse>>(async (event) => {
  const body = (await readBody<RemoteMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    const link = await machine.connect(machineIdOf(body), new AbortController().signal)
    return { tunnelBaseUrl: link.tunnelBaseUrl }
  })
})
