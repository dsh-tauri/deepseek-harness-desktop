import type { EventHandlerRequest } from 'h3'
import type { SshMachineEventsQuery, SshMachineEventsResponse } from '../../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { events } from '../../../../service/events'
import { guarded, machineIdOf, sinceSeqOf } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<SshMachineEventsResponse>>(async (event) => {
  const query = getQuery<SshMachineEventsQuery>(event)
  return guarded(event, async () => {
    const page = events.since(machineIdOf(query), sinceSeqOf(query))
    return { items: page.events, nextSeq: page.nextSeq }
  })
})
