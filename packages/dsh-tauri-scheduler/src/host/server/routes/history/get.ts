import type { EventHandlerRequest } from 'h3'
import type { GetHistoryQuery, RunListResponse } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { history } from '../../../service/history'

export default defineEventHandler<EventHandlerRequest, Promise<RunListResponse>>(async (event) => {
  const query = getQuery<GetHistoryQuery>(event)
  const rawLimit = query.limit as unknown
  const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : typeof rawLimit === 'number' ? rawLimit : Number.NaN
  const result = await history.query({ taskId: query.taskId, limit, before: query.before })
  if (!result.ok)
    event.res.status = 400
  return result
})
