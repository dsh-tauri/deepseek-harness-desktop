import type { WorktreeSessionState } from './worktree.types'

export const EMPTY_SESSION_STATE: WorktreeSessionState = {
  mode: 'local',
  isGit: null,
  phase: 'idle',
  loadingLabel: '',
  log: [],
  worktreeKey: '',
  worktreePath: '',
  projectPath: '',
  sourceSessionId: '',
  branchName: 'dsh/',
  checkoutOpen: false,
  abandonOpen: false,
  error: '',
}

export function sessionStateOf<C extends { bySession: Record<string, unknown> }>(
  state: C,
  sessionId: string | undefined,
): WorktreeSessionState {
  if (sessionId === undefined)
    return EMPTY_SESSION_STATE
  return (state.bySession[sessionId] as WorktreeSessionState | undefined) ?? EMPTY_SESSION_STATE
}
