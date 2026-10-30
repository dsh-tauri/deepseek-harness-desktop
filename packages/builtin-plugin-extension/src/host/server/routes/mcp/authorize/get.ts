import type { EventHandlerRequest } from 'h3'
import { defineEventHandler, getQuery } from 'h3'
import { mcpAuth } from '../../../../service/mcp-auth'

export default defineEventHandler<EventHandlerRequest, Promise<{ status: 'pending' | 'authorized' | 'error', error?: string } | { error: string }>>(async (event) => {
  const { attemptId } = getQuery(event)
  if (typeof attemptId !== 'string' || attemptId === '') {
    event.res.status = 400
    return { error: 'attemptId is required' }
  }
  const attempt = mcpAuth.lookup(attemptId)
  if (attempt === undefined) {
    event.res.status = 404
    return { error: 'authorization attempt not found' }
  }
  return attempt
})
