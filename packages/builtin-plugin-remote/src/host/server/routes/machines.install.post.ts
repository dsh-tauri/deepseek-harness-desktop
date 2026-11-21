import type { EventHandlerRequest } from 'h3'
import type { RemoteInstallRequestBody, RemoteInstallResponse } from './index.types'
import { defineEventHandler, readBody } from 'h3'
import { machine } from '../../service/machine'
import { ackProfileMismatchOf, guarded, machineIdOf, reinstallOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteInstallResponse>>(async (event) => {
  const body = (await readBody<RemoteInstallRequestBody>(event)) ?? {}
  return guarded(event, async () => {
    return await machine.install(machineIdOf(body), { force: reinstallOf(body), ackProfileMismatch: ackProfileMismatchOf(body) }, new AbortController().signal)
  })
})
