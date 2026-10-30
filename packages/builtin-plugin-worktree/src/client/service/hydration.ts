import type { GetApiTauriWorktreeBindingsResponse, GetApiTauriWorktreeStatusResponse as WorktreeStatus } from '../apis/index.type'
import type { WorktreeSessionState } from '../store/modules/worktree.types'
import type {
  BindingsProjection,
  CalibrationResult,
  HandoffDecision,
  HydrationState,
  RetryPlan,
} from './hydration.types'
import { forEach, keyBy } from 'dsh-tauri/client'
import {
  getBindings,
  getStatus,
} from '../apis'
import {
  HANDOFF_WINDOW_MS,
  HYDRATION_MAX_RETRIES,
  HYDRATION_RETRY_BUDGET_PER_SECOND,
  HYDRATION_RETRY_WINDOW_MS,
} from '../constants'
import { store } from '../store'
import { sessionStateOf } from '../store/modules/worktree.utils'

export function createHydrationState(): HydrationState {
  return {
    switching: new Map(),
    archivedIds: new Set(),
    inFlight: new Set(),
    queued: new Set(),
    gitResolved: new Set(),
    exhausted: new Set(),
    lastRunning: new Map(),
    baselineIds: new Set(),
    appearedAt: new Map(),
    worktreeReconciled: new Set(),
    handedOff: new Set(),
    subscribedSessions: new Set(),
    retryAttempts: new Map(),
    retryWindowStart: new Map(),
    discardPolls: new Map(),
    retryWindowStartAt: 0,
    retrySlotUsed: 0,
    baselineCaptured: false,
  }
}

export function clearRetryBookkeeping(state: HydrationState): void {
  state.retryAttempts.clear()
  state.retryWindowStart.clear()
  state.discardPolls.clear()
}

export function isArchived(state: HydrationState, sessionId: string): boolean {
  return state.archivedIds.has(sessionId)
}

export function isKnownGit(state: HydrationState, sessionId: string): boolean {
  return state.gitResolved.has(sessionId)
}

export function noteListBaseline(state: HydrationState, ids: readonly string[]): void {
  if (state.baselineCaptured || ids.length === 0)
    return
  state.baselineCaptured = true
  forEach(ids, id => state.baselineIds.add(id))
}

export function noteAppearances(state: HydrationState, ids: readonly string[], now: number): void {
  forEach(ids, (id) => {
    if (!state.appearedAt.has(id))
      state.appearedAt.set(id, now)
  })
}

export function clearRetry(state: HydrationState, sessionId: string): void {
  state.retryAttempts.delete(sessionId)
  state.retryWindowStart.delete(sessionId)
}

export function markResolved(state: HydrationState, sessionId: string): void {
  state.gitResolved.add(sessionId)
  clearRetry(state, sessionId)
}

export function planRetry(state: HydrationState, sessionId: string, now: number): RetryPlan {
  if (!state.retryWindowStart.has(sessionId))
    state.retryWindowStart.set(sessionId, now)

  const started = state.retryWindowStart.get(sessionId) ?? now
  const attempts = state.retryAttempts.get(sessionId) ?? 0
  if (now - started > HYDRATION_RETRY_WINDOW_MS || attempts >= HYDRATION_MAX_RETRIES) {
    state.retryAttempts.delete(sessionId)
    state.exhausted.add(sessionId)
    return 'exhausted'
  }

  state.retryAttempts.set(sessionId, attempts + 1)
  if (now - state.retryWindowStartAt >= 1000) {
    state.retryWindowStartAt = now
    state.retrySlotUsed = 0
  }
  if (state.retrySlotUsed >= HYDRATION_RETRY_BUDGET_PER_SECOND)
    return 'throttled'
  state.retrySlotUsed += 1
  return 'dispatch'
}

export function shouldCalibrate(state: HydrationState, sessionId: string): boolean {
  return !isArchived(state, sessionId) && !state.gitResolved.has(sessionId) && !state.exhausted.has(sessionId)
}

export function planDiscardPoll(state: HydrationState, sessionId: string, jobId: string, attempts: number): boolean {
  const current = state.discardPolls.get(sessionId)
  if (current?.jobId === jobId && current.attempts >= attempts)
    return false
  state.discardPolls.set(sessionId, { jobId, attempts })
  return true
}

export function isWorktree(sessionId: string): boolean {
  return sessionStateOf(store.worktree.$state, sessionId).mode === 'worktree'
}

export function projectBinding(binding: GetApiTauriWorktreeBindingsResponse['bindings'][number]): Partial<WorktreeSessionState> {
  return {
    mode: 'worktree',
    phase: 'created',
    isGit: true,
    worktreeKey: binding.worktreeKey,
    worktreePath: binding.worktreePath,
    projectPath: binding.projectPath,
    sourceSessionId: binding.sourceSessionId,
    log: binding.log,
    error: '',
  }
}

export function projectJob(job: GetApiTauriWorktreeBindingsResponse['jobs'][number]): Partial<WorktreeSessionState> {
  return {
    mode: 'worktree',
    phase: job.state === 'deleting' ? 'deleting' : 'error',
    error: job.error ?? '',
    worktreeKey: job.worktreeKey,
    worktreePath: job.worktreePath ?? '',
  }
}

export function projectLocal(projectPath?: string): Partial<WorktreeSessionState> {
  return {
    mode: 'local',
    phase: 'idle',
    isGit: true,
    loadingLabel: '',
    log: [],
    worktreeKey: '',
    worktreePath: '',
    ...(projectPath !== undefined ? { projectPath } : {}),
    sourceSessionId: '',
    checkoutOpen: false,
    abandonOpen: false,
    error: '',
  }
}

export function projectNonGit(projectPath?: string): Partial<WorktreeSessionState> {
  return {
    ...projectLocal(projectPath),
    isGit: false,
  }
}

export async function syncBindings(input: {
  state: HydrationState
  ids: readonly string[]
  current?: string
}): Promise<BindingsProjection | undefined> {
  let snapshot
  try {
    snapshot = await getBindings()
  }
  catch {
    return undefined
  }

  const bound = keyBy(snapshot.bindings, 'sessionId')
  const jobs = keyBy(snapshot.jobs, 'sessionId')
  const touched: BindingsProjection = { bound: [], current: input.current }

  forEach(input.ids, (sessionId) => {
    if (isArchived(input.state, sessionId))
      return
    const binding = bound[sessionId]
    if (binding) {
      store.worktree.patch(sessionId, projectBinding(binding))
      markResolved(input.state, sessionId)
      touched.bound.push({ sessionId, sourceSessionId: binding.sourceSessionId })
      return
    }
    const job = jobs[sessionId]
    if (job) {
      store.worktree.patch(sessionId, projectJob(job))
      return
    }
    if (isWorktree(sessionId))
      store.worktree.patch(sessionId, projectLocal())
  })

  return touched
}

export async function calibrateSession(input: {
  state: HydrationState
  sessionId: string
}): Promise<CalibrationResult> {
  const previous = sessionStateOf(store.worktree.$state, input.sessionId)
  let status: WorktreeStatus
  try {
    status = await getStatus({ sessionId: input.sessionId })
  }
  catch {
    return { kind: 'unknown' }
  }

  if (status.mode === 'deleting' || status.mode === 'failed') {
    store.worktree.patch(input.sessionId, {
      mode: 'worktree',
      phase: status.mode === 'deleting' ? 'deleting' : 'error',
      error: status.error ?? '',
      worktreeKey: previous.worktreeKey,
      worktreePath: previous.worktreePath,
    })
    return { kind: status.mode, jobId: status.jobId }
  }

  if (status.mode === 'worktree') {
    store.worktree.patch(input.sessionId, {
      mode: 'worktree',
      phase: 'created',
      isGit: status.isGit !== false,
      worktreeKey: status.worktreeKey ?? '',
      worktreePath: status.worktreePath ?? '',
      projectPath: status.projectPath ?? '',
      sourceSessionId: status.sourceSessionId ?? '',
      log: status.log ?? [],
    })
    markResolved(input.state, input.sessionId)
    return { kind: 'worktree', sourceSessionId: status.sourceSessionId ?? '' }
  }

  if (status.isGit === null)
    return { kind: 'pending' }

  markResolved(input.state, input.sessionId)
  if (status.isGit === false) {
    store.worktree.patch(input.sessionId, projectNonGit(status.projectPath ?? previous.projectPath))
    return { kind: 'notGit' }
  }
  if (previous.mode === 'worktree')
    store.worktree.patch(input.sessionId, projectLocal(status.projectPath ?? previous.projectPath))
  else
    store.worktree.patch(input.sessionId, { isGit: true })
  return { kind: 'local' }
}

export { loadJobStatus } from './worktree'

export function planHandoff(input: {
  state: HydrationState
  sessionId: string
  sourceSessionId: string
  current?: string
  now: number
}): HandoffDecision | undefined {
  const { state, sessionId, sourceSessionId } = input
  if (!sourceSessionId || state.worktreeReconciled.has(sessionId))
    return undefined
  state.worktreeReconciled.add(sessionId)

  const appeared = state.appearedAt.get(sessionId)
  const fresh = !state.baselineIds.has(sessionId)
    && appeared !== undefined
    && input.now - appeared <= HANDOFF_WINDOW_MS
  if (!fresh || input.current !== sourceSessionId)
    return undefined
  if (state.handedOff.has(sourceSessionId) || state.switching.has(sourceSessionId))
    return undefined

  state.handedOff.add(sourceSessionId)
  state.switching.set(sourceSessionId, sessionId)
  return { sourceSessionId, targetSessionId: sessionId }
}
