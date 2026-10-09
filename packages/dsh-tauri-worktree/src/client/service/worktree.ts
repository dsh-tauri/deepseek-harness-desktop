import type { GetApiTauriWorktreeStatusResponse as WorktreeStatus } from '../apis/index.type'
import type { ActionResult, CheckoutOutcome, CreateOutcome, DiscardOutcome, DiscardProgress } from './worktree.types'
import { get } from 'dsh-tauri/client'
import { deleteWorktree, getStatus, postBindings, postCheckouts, postWorktree } from '../apis'
import { locale } from '../locales'
import { store } from '../store'

export function localize(sessionId: string): void {
  store.worktree.patch(sessionId, {
    mode: 'local',
    phase: 'idle',
    loadingLabel: '',
    log: [],
    worktreeKey: '',
    worktreePath: '',
    abandonOpen: false,
    error: '',
  })
}

export async function create(input: {
  sessionId: string
  sourceSessionId: string
  inherit: boolean
}): Promise<CreateOutcome> {
  try {
    const created = await postWorktree(input)
    store.worktree.patch(input.sessionId, {
      mode: 'worktree',
      phase: 'created',
      loadingLabel: locale.text('progressCreated'),
      log: created.log,
      worktreeKey: created.worktreeKey,
      worktreePath: created.worktreePath,
      projectPath: created.projectPath,
      sourceSessionId: created.sourceSessionId,
      error: '',
    })
    return { ok: true, result: created }
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}

export async function attach(input: { sessionId: string }): Promise<ActionResult> {
  try {
    await postBindings(input)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}

export async function checkout(input: {
  sessionId: string
  worktreeKey: string
  branchName: string
}): Promise<CheckoutOutcome> {
  try {
    const result = await postCheckouts({
      sessionId: input.sessionId,
      worktreeHashDirname: input.worktreeKey,
      branchName: input.branchName,
    })
    store.worktree.patch(input.sessionId, {
      mode: 'local',
      phase: 'idle',
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      checkoutOpen: false,
      error: '',
    })
    return { ok: true, targetSessionId: result.targetSessionId }
  }
  catch (error) {
    store.worktree.patch(input.sessionId, { error: get(error, 'message', String(error)) })
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}

export async function discard(input: {
  sessionId: string
  worktreeKey: string
}): Promise<DiscardOutcome> {
  store.worktree.patch(input.sessionId, { phase: 'deleting', abandonOpen: false, error: '' })
  try {
    const result = await deleteWorktree({
      sessionId: input.sessionId,
      worktreeHashDirname: input.worktreeKey,
    })
    if (!result.ok) {
      const error = result.error ?? 'Failed to start worktree deletion.'
      store.worktree.patch(input.sessionId, { phase: 'error', error })
      return { ok: false, error }
    }
    if (!result.jobId) {
      localize(input.sessionId)
      return { ok: true }
    }
    return { ok: true, jobId: result.jobId }
  }
  catch (error) {
    const text = get(error, 'message', String(error))
    store.worktree.patch(input.sessionId, { phase: 'error', error: text })
    return { ok: false, error: text }
  }
}

export async function loadJobStatus(input: {
  sessionId: string
  jobId: string
}): Promise<WorktreeStatus | undefined> {
  try {
    return await getStatus(input)
  }
  catch {
    return undefined
  }
}

export async function loadDiscardProgress(input: {
  sessionId: string
  jobId: string
}): Promise<DiscardProgress> {
  const status = await loadJobStatus(input)
  if (!status)
    return 'other'
  if (status.mode === 'deleting')
    return 'deleting'
  if (status.mode === 'failed') {
    store.worktree.patch(input.sessionId, {
      phase: 'error',
      error: status.error ?? 'Failed to delete worktree.',
    })
    return 'failed'
  }
  if (status.mode === 'local') {
    localize(input.sessionId)
    return 'done'
  }
  const error = 'Worktree deletion did not complete.'
  store.worktree.patch(input.sessionId, { phase: 'error', error })
  return 'failed'
}
