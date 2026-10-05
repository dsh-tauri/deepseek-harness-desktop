import type { EventHandlerRequest } from 'h3'
import type { RemoteMachineIdBody, RemoteTestResponse } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteTestResponse>>(async (event) => {
  const body = (await readBody<RemoteMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    return await machine.test(machineIdOf(body), new AbortController().signal)
  })
})
