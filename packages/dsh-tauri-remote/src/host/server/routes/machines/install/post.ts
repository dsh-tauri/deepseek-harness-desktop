import type { EventHandlerRequest } from 'h3'
import type { RemoteInstallResponse, RemoteMachineIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteInstallResponse>>(async (event) => {
  const body = (await readBody<RemoteMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    return await machine.install(machineIdOf(body), new AbortController().signal)
  })
})
