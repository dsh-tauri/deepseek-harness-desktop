import type { EventHandlerRequest } from 'h3'
import type { SshActionResponse, SshMachineIdBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../../service/machine'
import { guarded, machineIdOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshActionResponse>>(async (event) => {
  const body = (await readBody<SshMachineIdBody>(event)) ?? {}
  return guarded(event, async () => {
    await machine.disconnect(machineIdOf(body))
    return {}
  })
})
