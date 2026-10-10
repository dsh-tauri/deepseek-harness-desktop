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
  /** 上次「全部标记为已读」的时间戳；`0` 表示尚未播种（历史一律视为已读）。 */
  readAt: number
  /** 单条已读的运行 id（点击该记录、或在会话区打开它的会话时记入）。 */
  readIds: string[]
}
