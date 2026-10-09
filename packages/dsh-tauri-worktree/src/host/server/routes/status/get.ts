import type { EventHandlerRequest } from 'h3'
import type { GetStatusQuery, WorktreeStatus } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { status } from '../../../service/status'

export default defineEventHandler<EventHandlerRequest, Promise<WorktreeStatus>>(async (event) => {
  const query = getQuery<GetStatusQuery>(event)
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  const jobId = typeof query.jobId === 'string' ? query.jobId : ''
  const facts = await status.resolve(sessionId, jobId)
  if (facts.mode === 'missing') {
    event.res.status = 404
    return { error: '未找到工作树删除任务' }
  }
  return facts
})
