import type { GetApiTauriSchedulerHistoryResponse, GetApiTauriSchedulerTasksResponse } from '../apis/index.type'

export type ScheduleKind = 'once' | 'hourly' | 'daily' | 'interval' | 'workdays' | 'weekly' | 'monthly' | 'custom'

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

export type TaskDelivery = 'this-session' | 'new-session'
export type TaskStatus = 'active' | 'inactive'

export type ScheduleForm = (
  | { kind: 'once', at: string }
  | { kind: 'hourly', minute: number }
  | { kind: 'daily', time: string }
  | { kind: 'interval', everyMinutes: number, anchor?: string }
  | { kind: 'workdays', time: string }
  | { kind: 'weekly', weekdays: readonly Weekday[], time: string }
  | { kind: 'monthly', day: number, time: string }
  | { kind: 'custom', everyDays: number, anchor?: string, time: string }
) & { timeZone?: string }

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelReasoning {
  efforts: readonly ModelReasoningEffort[]
  defaultEffort?: string
}

export interface ModelOption {
  provider: string
  providerLabel: string
  model: string
  label: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelCatalogFailure {
  provider: string
  providerLabel: string
  message: string
}

type TaskRecord = GetApiTauriSchedulerTasksResponse['tasks'][number]
export type TaskView = Omit<TaskRecord, 'schedule'> & {
  schedule: Exclude<TaskRecord['schedule'], { kind: 'weekly' }>
    | (Omit<Extract<TaskRecord['schedule'], { kind: 'weekly' }>, 'weekdays'> & { weekdays: readonly Weekday[] })
}
type HistoryResponse = Extract<GetApiTauriSchedulerHistoryResponse, { ok: true }>
export type HistoryPage = Omit<HistoryResponse, 'ok' | 'runs'>
export type HistoryRecord = HistoryPage['records'][number]
export type RunView = HistoryResponse['runs'][number]
export type RunStatus = RunView['status']

export interface TaskFormState {
  delivery: TaskDelivery
  sessionId: string
  enabled: boolean
  recommendationId?: string
  name: string
  schedule: ScheduleForm
  prompt: string
  workspaceId: string
  permission: string
  provider: string
  model: string
  reasoningEffort: string
}

export interface SchedulerOptions {
  workspaces: readonly { id: string, path: string, title: string }[]
  permissions: readonly PermissionOption[]
  defaultPermission: string
  models: readonly ModelOption[]
  failures: readonly ModelCatalogFailure[]
  defaultModel: ModelOption | null
}

export interface TaskInput {
  delivery: TaskDelivery
  sessionId?: string
  name: string
  schedule: ScheduleForm
  prompt: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  recommendationId?: string
  enabled?: boolean
}
