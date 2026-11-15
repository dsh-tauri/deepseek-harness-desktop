import type { EventHandlerRequest } from 'h3'
import type { GetCoreCurrentQuery, RemoteCoreCurrentResponse } from './index.types'
import { defineEventHandler, getQuery } from 'h3'
import { core } from '../../service/core'
import { guarded, machineIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreCurrentResponse>>(async (event) => {
  const query = getQuery<GetCoreCurrentQuery>(event)
  return guarded(event, async () => ({ item: await core.resolve(machineIdOf(query)) }))
})
