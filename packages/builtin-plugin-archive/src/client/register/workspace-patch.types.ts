import type { WorkspaceViewLike } from '../types/runtime'

export interface WorkspaceArchiveTarget {
  workspace: WorkspaceViewLike | undefined
  sessionIds: string[]
}
