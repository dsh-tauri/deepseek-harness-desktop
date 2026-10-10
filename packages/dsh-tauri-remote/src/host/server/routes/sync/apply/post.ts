import type { EventHandlerRequest } from 'h3'
import type { SyncApplyBody, SyncApplyResponse } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { sync } from '../../../../service/sync'
import { guarded, machineIdOf, pluginRefsOf, skillRefsOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SyncApplyResponse>>(async (event) => {
  const body = (await readBody<SyncApplyBody>(event)) ?? {}
  return guarded(event, async () => {
    return await sync.apply(machineIdOf(body), pluginRefsOf(body), skillRefsOf(body))
  })
})
