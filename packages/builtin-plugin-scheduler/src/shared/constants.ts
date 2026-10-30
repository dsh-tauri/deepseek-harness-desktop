import type {} from '@deepseek-ai/dsh-session-projection/types'

export const PLUGIN_ID = 'dsh-tauri-scheduler'

export const SCHEDULE_TOOL_NAMES = {
  create: 'schedule_create',
  list: 'schedule_list',
  update: 'schedule_update',
  delete: 'schedule_delete',
} as const

export const SESSION_SCHEDULE_ORIGIN_PROJECTION = 'dsh-tauri-scheduler.origin'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    [SESSION_SCHEDULE_ORIGIN_PROJECTION]: boolean
  }
}

export const SCHEDULE_KINDS = ['once', 'hourly', 'daily', 'interval', 'workdays', 'weekly', 'monthly', 'custom', 'cron'] as const

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
