import type { SchedulerRun, SchedulerScheduleInput, SchedulerTask } from '../../types'

export interface TaskCreateBody {
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

export interface RunListResponse {
  runs: SchedulerRun[]
}

export interface TaskActionResult {
  ok?: boolean
  task?: SchedulerTask
  error?: string
}

export interface GetTasksQuery {
  search?: string
}

export interface GetHistoryQuery {
  taskId?: string
}

export interface ActionResult {
  ok?: boolean
  error?: string
}
