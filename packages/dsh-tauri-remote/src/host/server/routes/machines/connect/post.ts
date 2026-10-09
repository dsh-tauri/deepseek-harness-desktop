import type { EventHandlerRequest } from 'h3'
import type { SshConnectResponse, SshMachineIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshConnectResponse>>(async (event) => {
  const body = (await readBody<SshMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    const link = await machine.connect(machineIdOf(body), new AbortController().signal)
    return { tunnelBaseUrl: link.tunnelBaseUrl }
  })
})
