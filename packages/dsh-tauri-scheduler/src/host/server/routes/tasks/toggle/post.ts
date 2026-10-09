import type { EventHandlerRequest } from 'h3'
import type { TaskActionResult, TaskToggleBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { task } from '../../../../service/task'

export default defineEventHandler<EventHandlerRequest, Promise<TaskActionResult>>(async (event) => {
  const body = await readBody<TaskToggleBody>(event)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (id.length === 0) {
    event.res.status = 400
    return { error: '缺少任务 id' }
  }
  const result = await task.toggle(id, body?.enabled === true)
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return { ok: true, task: result.task }
})
