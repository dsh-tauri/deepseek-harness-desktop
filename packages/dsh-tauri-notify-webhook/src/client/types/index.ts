export type NotifyTrigger = 'completed' | 'abnormal'

export interface ServiceResult {
  ok: boolean
  error?: string
}

export interface ObservableSnapshotFace<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

export interface SessionSummaryFace {
  readonly id: string
  readonly title?: string
  readonly displayTitle?: string
  readonly origin?: 'subagent'
  readonly running: boolean
}

export interface SessionListStateFace {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryFace>>
}

export interface SessionsFace {
  readonly list: ObservableSnapshotFace<SessionListStateFace>
}
