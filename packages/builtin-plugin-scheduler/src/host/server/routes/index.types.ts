import type { HistoryPage, OperationResult, SchedulerScheduleInput, SchedulerTask, TaskDelivery } from '../../types'

export interface TaskCreateBody {
  delivery: TaskDelivery
  sessionId?: string
  name: string
  schedule: SchedulerScheduleInput
  prompt: string
  recommendationId?: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  enabled?: boolean
}

export interface TaskUpdateBody {
  id: string
  expected: SchedulerTask
  delivery?: TaskDelivery
  sessionId?: string
  name?: string
  schedule?: SchedulerScheduleInput
  prompt?: string
  recommendationId?: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  enabled?: boolean
}

export interface IdBody {
  id: string
}

export interface TaskToggleBody {
  id: string
  enabled: boolean
}

export interface TaskListResponse {
  tasks: SchedulerTask[]
}

export type RunListResponse = OperationResult<HistoryPage>

export interface TaskActionResult {
  ok?: boolean
  task?: SchedulerTask
  error?: string
  code?: string
}

export interface GetTasksQuery {
  search?: string
}

export interface GetHistoryQuery {
  taskId?: string
  limit: number
  before?: string
}

export interface ActionResult {
  ok?: boolean
  error?: string
  code?: string
}
