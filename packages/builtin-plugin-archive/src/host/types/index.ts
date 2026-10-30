export interface SessionHeaderLike {
  createdAt?: number
  cwd?: string
}

export interface SessionLike {
  id: string
  header?: SessionHeaderLike
  title?: string
  displayTitle?: string
}

export interface SessionStoreSurface {
  get?: (sessionId: string) => SessionLike | undefined
  list?: () => SessionLike[]
  remove?: (sessionId: string) => boolean
}

export interface ArchiveTableSurface {
  entries: () => Iterable<[string, { sessionIds?: readonly string[] }]>
  update: (workspaceId: string, update: (record: { sessionIds?: readonly string[] }) => { sessionIds: string[] }) => Promise<void>
}

export interface WorkspaceEntryLike {
  id: string
  path?: string
  sessionIds?: readonly string[]
}

export interface ArchiveRegistrySurface {
  archivedSessionIds?: readonly string[]
  archiveSession?: (sessionId: string) => Promise<void>
  list?: () => WorkspaceEntryLike[]
  enqueueOperation?: (fn: () => Promise<void>) => Promise<void>
  requireState?: () => { archivedSessionIds?: readonly string[] }
  requireTable?: () => ArchiveTableSurface
  setState?: (state: unknown) => Promise<void>
}

export interface SessionHost {
  sessions: SessionStoreSurface
  workspaceRegistry: ArchiveRegistrySurface
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
}
