import type { EventHandlerRequest } from 'h3'
import type { GetCoreInstanceQuery, RemoteCoreInstanceResponse } from './index.types'
import { defineEventHandler, getQuery } from 'h3'
import { core } from '../../service/core'
import { guarded, machineIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreInstanceResponse>>(async (event) => {
  const query = getQuery<GetCoreInstanceQuery>(event)
  return guarded(event, async () => ({ item: await core.instanceStatus(machineIdOf(query)) }))
})
