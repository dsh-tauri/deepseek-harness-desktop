import type { EventHandlerRequest } from 'h3'
import type { TaskActionResult, TaskCreateBody } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { task } from '../../../service/task'

export default defineEventHandler<EventHandlerRequest, Promise<TaskActionResult>>(async (event) => {
  const body = await readBody<TaskCreateBody>(event)
  if (body === undefined) {
    event.res.status = 400
    return { error: '请求体必须是对象' }
  }
  const result = await task.create(body)
  if (!result.ok) {
    event.res.status = 400
    return { ok: false, error: result.error, code: result.code }
  }
  return { ok: true, task: result.task }
})
