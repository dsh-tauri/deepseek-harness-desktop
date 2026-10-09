import type { EventHandlerRequest } from 'h3'
import type { SshActionResponse, SshMachineSaveBody } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../service/machine'
import { guarded, machineIdOf, saveRowOf, secretsOf } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshActionResponse>>(async (event) => {
  const body = (await readBody<SshMachineSaveBody>(event)) ?? {}
  return guarded(event, async () => {
    await machine.save(machineIdOf(body), saveRowOf(body), secretsOf(body))
    return {}
  })
})
