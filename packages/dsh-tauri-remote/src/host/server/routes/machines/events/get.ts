import type { EventHandlerRequest } from 'h3'
import type { GetMachinesEventsQuery, RemoteMachineEventsResponse } from '../../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { events } from '../../../../service/events'
import { guarded, machineIdOf, sinceSeqOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteMachineEventsResponse>>(async (event) => {
  const query = getQuery<GetMachinesEventsQuery>(event)
  return guarded(event, async () => {
    const page = events.since(machineIdOf(query), sinceSeqOf(query))
    return { items: page.events, nextSeq: page.nextSeq }
  })
})
