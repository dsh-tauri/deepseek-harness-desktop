import type { RunView, SchedulerOptions, TaskView } from '../../types'

export interface SchedulerUiState {
  tasks: TaskView[]
  runs: RunView[]
  options: SchedulerOptions
  loading: boolean
  error: string
  refreshedAt: number
  loadToken: number
  successfulReadToken: number
  readAt: number
  readIds: string[]
}
