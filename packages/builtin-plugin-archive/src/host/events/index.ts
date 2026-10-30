import { createHooks } from 'hookable'

export interface ArchiveLifecycleHooks {
  'archive:added': (sessionId: string) => void
  'archive:restored': (sessionId: string) => void
  'archive:deleted': (sessionIds: readonly string[]) => void
}

export const archiveHooks = createHooks<ArchiveLifecycleHooks>()
