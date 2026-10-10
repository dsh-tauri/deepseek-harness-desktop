import type {} from '@deepseek-ai/dsh-session-projection/types'

/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量（dsh-tauri-scheduler）。
 *
 * 插件名与线协议枚举是两半端共享的协议面：host 路由注册、client RPC 各自硬编码
 * 会漂移，集中在此由两端共同引用（host/constants.ts 与 client/constants.ts 消费）。
 */

/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
export const PLUGIN_ID = 'dsh-tauri-scheduler'

export const SESSION_SCHEDULE_ORIGIN_PROJECTION = 'dsh-tauri-scheduler.origin'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    [SESSION_SCHEDULE_ORIGIN_PROJECTION]: boolean
  }
}

/** 计划类型集合（与 DSH automation 工具的语义一一对应）。 */
export const SCHEDULE_KINDS = ['once', 'hourly', 'daily', 'interval', 'workdays', 'weekly', 'monthly', 'custom'] as const

/** 星期枚举（IATA 三字母，与 DSH automation 一致）。 */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
