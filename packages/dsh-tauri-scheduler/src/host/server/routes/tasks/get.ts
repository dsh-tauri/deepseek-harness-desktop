import type { EventHandlerRequest } from 'h3'
import type { GetTasksQuery, TaskListResponse } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { castArray } from 'lodash-es'
import { scheduler } from '../../../service/scheduler'
import { task } from '../../../service/task'

export default defineEventHandler<EventHandlerRequest, Promise<TaskListResponse>>(async (event) => {
  const raw = getQuery<GetTasksQuery>(event).search
  const search = castArray(raw)[0] ?? ''
  const [tasks, waiting] = await Promise.all([task.list(search), scheduler.waitingIds()])
  return { tasks: tasks.map(item => waiting.has(item.id) ? { ...item, waiting: true } : item) }
})
