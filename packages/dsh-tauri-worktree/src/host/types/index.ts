export type HostContext = any

export interface WorktreeProcessController {
  stopSessionProcesses?: (sessionId: string, worktreePath: string) => Promise<void>
}

export interface Binding {
  sessionId: string
  sourceSessionId: string
  hash: string
  dirname: string
  worktreePath: string
  projectPath: string
  branchName: string
  ownsBranch: boolean
  createdAt: string
  log: string[]
  linkedDependencies?: string[]
}

export type Ledger = Record<string, Binding>

export interface CheckoutContext {
  projectPath: string
  branch?: string
  worktreePath?: string
  checkedOutAt: string
}

export type CheckoutContexts = Record<string, CheckoutContext>

export interface GitOptions {
  timeout?: number
  signal?: AbortSignal
}

export interface EnsureOptions extends GitOptions {
  sourceSessionId?: string
  branchName?: string
  carryStaged?: boolean
  linkDependencies?: boolean
  linkDependencyDirectories?: string[]
}

export interface CheckoutOptions extends GitOptions {
  beforeRemove?: (checkout: { branch: string, projectPath: string, worktreePath: string }) => Promise<OperationResult<any>>
  carryStaged?: boolean
  linkDependencyDirectories?: string[]
}

export interface CheckoutInfo {
  branch?: string
  worktreePath?: string
}

export interface PendingHandoff {
  sourceAgent: any
  targetSessionId: string
  binding: Binding
}

export type OperationResult<T extends object = object>
  = | ({ ok: true } & T)
    | { ok: false, error: string }

export interface WorktreeParams {
  worktree_hash_dirname?: string
  worktreeHashDirname?: string
  sessionId?: string
  branch_name?: string
}

export interface DiscardJob {
  jobId: string
  sessionId: string
  worktreeKey: string
  worktreePath?: string
  state: 'deleting' | 'completed' | 'failed'
  error?: string
  attempts?: number
}

export interface WorktreeStatusFacts {
  mode: 'local' | 'worktree' | 'deleting' | 'failed' | 'missing'
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
