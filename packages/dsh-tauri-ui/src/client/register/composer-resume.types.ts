export interface ComposerListProjection {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { current?: string }
}

export interface ComposerSessionSnapshot {
  running?: boolean
  removed?: boolean
  subagent?: unknown
}

export interface ComposerTurnEndError {
  message?: string
  code?: string
  status?: number
}

export interface ComposerSessionEventEntry {
  type?: string
  event?: {
    type?: string
    seq?: number
    data?: { reason?: { kind?: string, error?: ComposerTurnEndError } }
  }
}

/** 已确认的内容审核拒绝：provider 原文 + 内核错误码 + HTTP 状态。 */
export interface ComposerRefusal {
  message: string
  code: string
  status: number
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
  /** 分叉会话：内核 ≥0.1.7 起由官方服务提供，旧内核缺席时安全恢复不可用。 */
  fork?: (options: { sessionId: string, atSeq?: number, increaseTitle?: boolean }) => Promise<string>
  /** 打开已有会话：适配层在 0.1.7 把该能力补回 sessions（与右键菜单分叉同一条路径）。 */
  open?: (sessionId: string) => unknown
}

export interface ComposerIconState {
  path: string | null
  ariaLabel: string | null
}
