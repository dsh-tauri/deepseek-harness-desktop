import type { EventHandlerRequest } from 'h3'
import type { GetCoreProfilesQuery, RemoteCoreProfilesResponse } from './index.types'
import { defineEventHandler, getQuery } from 'h3'
import { core } from '../../service/core'
import { guarded, machineIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreProfilesResponse>>(async (event) => {
  const query = getQuery<GetCoreProfilesQuery>(event)
  return guarded(event, async () => ({ items: await core.listProfiles(machineIdOf(query)) }))
})
