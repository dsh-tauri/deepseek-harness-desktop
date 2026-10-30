export type WorktreePhase = 'idle' | 'creating' | 'created' | 'thinking' | 'deleting' | 'error'

export interface WorktreeSessionState {
  mode: 'local' | 'pending' | 'worktree'
  isGit: boolean | null
  phase: WorktreePhase
  loadingLabel: string
  log: string[]
  worktreeKey: string
  worktreePath: string
  projectPath: string
  sourceSessionId: string
  branchName: string
  checkoutOpen: boolean
  abandonOpen: boolean
  error: string
}

export type WorktreeSessionView
  = Readonly<Omit<WorktreeSessionState, 'log'>> & { readonly log: readonly string[] }

export interface WorktreeUiState {
  bySession: Record<string, WorktreeSessionState>
}
