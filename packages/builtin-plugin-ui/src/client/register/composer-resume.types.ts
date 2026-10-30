export interface ComposerListProjection {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { current?: string }
}

export interface ComposerSessionSnapshot {
  running?: boolean
  removed?: boolean
  subagent?: unknown
}

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
