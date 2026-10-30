export interface CreateBody {
  sessionId?: string
  sourceSessionId?: string
  carryStaged?: boolean
  inherit?: boolean
}

export interface DiscardBody {
  sessionId?: string
  worktreeHashDirname?: string
}

export interface AttachBody {
  sessionId?: string
}

export interface CheckoutBody {
  sessionId?: string
  worktreeHashDirname?: string
  branchName?: string
  carryStaged?: boolean
}

export interface GetStatusQuery {
  sessionId?: string
  jobId?: string
}

export interface WorktreeCreate {
  ok?: boolean
  error?: string
  hash?: string
  dirname?: string
  worktreeKey?: string
  worktreePath?: string
  projectPath?: string
  sourceSessionId?: string
  log?: string[]
  existed?: boolean
  inherited?: boolean
}

export interface WorktreeDiscard {
  ok?: boolean
  jobId?: string
  error?: string
}

export interface WorktreeAttach {
  ok?: boolean
  workspaceId?: string
  error?: string
}

export interface WorktreeCheckout {
  ok?: boolean
  branch?: string
  projectPath?: string
  targetSessionId?: string
  error?: string
}

export interface WorktreeBindingSummary {
  sessionId: string
  sourceSessionId: string
  hash: string
  dirname: string
  worktreeKey: string
  worktreePath: string
  projectPath: string
  log: string[]
}

export interface WorktreeDiscardJobSummary {
  sessionId: string
  jobId: string
  state: string
  error?: string
  worktreeKey: string
  worktreePath?: string
}

export interface WorktreeBindings {
  bindings: WorktreeBindingSummary[]
  jobs: WorktreeDiscardJobSummary[]
}

export interface WorktreeStatus {
  mode?: string
  jobId?: string
  error?: string
  hash?: string
  dirname?: string
  worktreeKey?: string
  worktreePath?: string
  projectPath?: string
  sourceSessionId?: string
  log?: string[]
  isGit?: boolean | null
}
