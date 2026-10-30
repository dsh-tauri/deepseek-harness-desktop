import type { GetApiTauriArchiveSessionArchiveResponse as ArchivedListPayload } from '../../apis/index.type'

export type ArchiveSort = 'updatedAt' | 'createdAt' | 'title'

export interface ArchiveState {
  archived: ArchivedListPayload
  sort: ArchiveSort
  query: string
  workspaceId: string
  loading: boolean
  pending: boolean
  error: string
  suppressedSessionIds: string[]
  titleById: Record<string, string>
  refreshGeneration: number
}
