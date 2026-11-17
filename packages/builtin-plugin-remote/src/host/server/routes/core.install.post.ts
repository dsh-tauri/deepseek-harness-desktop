import type { EventHandlerRequest } from 'h3'
import type { RemoteCoreInstallBody, RemoteCoreTaskAcceptedResponse } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { core } from '../../service/core'
import { coreTagOf, guarded, machineIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreTaskAcceptedResponse>>(async (event) => {
  const body = (await readBody<RemoteCoreInstallBody>(event)) ?? {}
  return guarded(event, async () => {
    return await core.installVersion(machineIdOf(body), coreTagOf(body), { force: body.force === true })
  })
})
