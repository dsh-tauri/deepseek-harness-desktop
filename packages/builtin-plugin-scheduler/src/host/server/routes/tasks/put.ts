import type { EventHandlerRequest } from 'h3'
import type { TaskActionResult, TaskUpdateBody } from '../index.types'
import { defineEventHandler, readBody } from 'h3'
import { task } from '../../../service/task'

export default defineEventHandler<EventHandlerRequest, Promise<TaskActionResult>>(async (event) => {
  const body = await readBody<TaskUpdateBody>(event)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!body || id.length === 0) {
    event.res.status = 400
    return { error: '缺少任务 id' }
  }
  if (!body.expected || typeof body.expected !== 'object' || Array.isArray(body.expected)) {
    event.res.status = 400
    return { ok: false, error: '缺少完整 expected 任务记录', code: 'task_expected_required' }
  }
  const { id: _id, expected, ...patch } = body
  const result = await task.update(id, patch, expected)
  if (!result.ok) {
    event.res.status = 400
    return { ok: false, error: result.error, code: result.code }
  }
  return { ok: true, task: result.task }
})
