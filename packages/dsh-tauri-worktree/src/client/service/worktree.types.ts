import type { PostApiTauriWorktreeResponse as WorktreeCreate } from '../apis/index.type'

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface CreateOutcome extends ActionResult {
  result?: WorktreeCreate
}

export interface CheckoutOutcome extends ActionResult {
  targetSessionId?: string
}

export interface DiscardOutcome extends ActionResult {
  jobId?: string
}

export type DiscardProgress = 'deleting' | 'done' | 'failed' | 'other'
