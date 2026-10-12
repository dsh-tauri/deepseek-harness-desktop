import type { EventHandlerRequest } from 'h3'
import type { PostTestResult } from '../index.types'
import { defineEventHandler } from 'h3'
import { notifier } from '../../../service/notifier'

export default defineEventHandler<EventHandlerRequest, Promise<PostTestResult>>(async () => {
  return notifier.test()
})
