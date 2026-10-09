export interface ComposerListProjection {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { current?: string }
}

export interface ComposerSessionSnapshot {
  running?: boolean
  removed?: boolean
  subagent?: unknown
}

/**
 * 客户端事件条目：`event` 只在 `type: 'event'` 上出现，且是宿主日志事件的逐字快照
 * （`seq` / `type` / `data`）。判定审核失败要读 `data.reason.error`，故这里保留原样，
 * 不把它收窄成只有 `kind` 的形状。
 */
export interface ComposerSessionEventEntry {
  type?: string
  event?: {
    type?: string
    seq?: number
    data?: {
      turn?: number
      reason?: { kind?: string, error?: unknown }
    }
  }
}

export interface ComposerSessionEventSource {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { entries?: readonly ComposerSessionEventEntry[] }
}

export interface ComposerSession {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => ComposerSessionSnapshot
}

export interface ComposerSessionBinding {
  session?: ComposerSession
  eventSource?: ComposerSessionEventSource
}

export interface ComposerSessionsRuntime {
  list?: ComposerListProjection
  binding?: (sessionId: string) => unknown
}

export interface ComposerIconState {
  path: string | null
  ariaLabel: string | null
}
