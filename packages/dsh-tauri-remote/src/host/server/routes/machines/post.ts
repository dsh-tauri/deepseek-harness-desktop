import type { EventHandlerRequest } from 'h3'
import type { RemoteActionResponse, RemoteMachineSaveBody } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../../service/machine'
import { guarded, machineIdOf, saveRowOf, secretsOf } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteActionResponse>>(async (event) => {
  const body = (await readBody<RemoteMachineSaveBody>(event)) ?? {}
  return guarded(event, async () => {
    await machine.save(machineIdOf(body), saveRowOf(body), secretsOf(body))
    return {}
  })
})
