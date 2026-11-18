import type { EventHandlerRequest } from 'h3'
import type { GetCoreTasksEventsQuery, RemoteCoreTaskEventsResponse } from './index.types'
import { defineEventHandler, getQuery } from 'h3'
import { tasks } from '../../service/tasks'
import { guarded, sinceSeqOf, taskIdOf } from './index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteCoreTaskEventsResponse>>(async (event) => {
  const query = getQuery<GetCoreTasksEventsQuery>(event)
  return guarded(event, async () => {
    const page = tasks.since(taskIdOf(query), sinceSeqOf(query))
    return { items: page.events, nextSeq: page.nextSeq }
  })
})
