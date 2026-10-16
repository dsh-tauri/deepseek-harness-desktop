import type { EventHandlerRequest } from 'h3'
import type { RemoteActionResponse, RemoteMachineIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteActionResponse>>(async (event) => {
  const body = (await readBody<RemoteMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    await machine.disconnect(machineIdOf(body))
    return {}
  })
})
