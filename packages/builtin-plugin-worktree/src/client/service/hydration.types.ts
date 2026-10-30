import type { SessionListSnapshot as SessionSwitchSnapshot } from './session-switch.types'

export interface SessionListSnapshot extends SessionSwitchSnapshot {
  phase?: 'pending' | 'ready'
}

export interface BoundSessionSource {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => { running?: boolean } | undefined
}

export interface WorktreeHydrationSessionsRuntime {
  binding: (sessionId: string) => { session?: BoundSessionSource } | undefined
  list: {
    getSnapshot: () => SessionListSnapshot
    subscribe: (listener: () => void) => () => void
  }
  open: (sessionId: string) => void
  refresh: () => Promise<void>
}

export interface WorkspaceListSnapshot {
  archivedSessionIds: readonly string[]
}

export interface HydrationState {
  switching: Map<string, string>
  archivedIds: Set<string>
  inFlight: Set<string>
  queued: Set<string>
  gitResolved: Set<string>
  exhausted: Set<string>
  lastRunning: Map<string, boolean>
  baselineIds: Set<string>
  appearedAt: Map<string, number>
  worktreeReconciled: Set<string>
  handedOff: Set<string>
  subscribedSessions: Set<string>
  retryAttempts: Map<string, number>
  retryWindowStart: Map<string, number>
  discardPolls: Map<string, { jobId: string, attempts: number }>
  retryWindowStartAt: number
  retrySlotUsed: number
  baselineCaptured: boolean
}

export type RetryPlan = 'exhausted' | 'throttled' | 'dispatch'

export type Calibration = 'worktree' | 'notGit' | 'local' | 'deleting' | 'failed' | 'pending' | 'unknown'

export interface CalibrationResult {
  kind: Calibration
  jobId?: string
  sourceSessionId?: string
}

export interface BindingsProjection {
  bound: Array<{ sessionId: string, sourceSessionId: string }>
  current?: string
}

export interface HandoffDecision {
  sourceSessionId: string
  targetSessionId: string
}
