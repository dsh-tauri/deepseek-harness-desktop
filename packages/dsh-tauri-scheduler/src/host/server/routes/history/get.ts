import type { EventHandlerRequest } from 'h3'
import type { GetHistoryQuery, RunListResponse } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { castArray } from 'lodash-es'
import { runs } from '../../../service/runs'

export default defineEventHandler<EventHandlerRequest, Promise<RunListResponse>>(async (event) => {
  const raw = getQuery<GetHistoryQuery>(event).taskId
  const taskId = castArray(raw)[0] ?? ''
  return { runs: await runs.list(taskId === '' ? undefined : taskId) }
})
