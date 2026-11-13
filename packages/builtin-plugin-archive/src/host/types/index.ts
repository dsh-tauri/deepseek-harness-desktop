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

export interface SessionStoreEntryLike {
  detach?: () => void
}

export interface SessionStoreSurface {
  get?: (sessionId: string) => SessionLike | undefined
  list?: () => SessionLike[]
  flush?: (session: SessionLike) => Promise<boolean>
  store?: ReadonlyMap<string, SessionStoreEntryLike>
}

export interface AgentLike {
  cancel?: (cause: { kind: 'disposed' }) => void
  whenIdle?: () => Promise<void>
}

export interface AgentRegistrySurface {
  get?: (sessionId: string) => AgentLike | undefined
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

export interface RegistryStateLike {
  archivedSessionIds?: readonly string[]
  pinnedSessionIds?: readonly string[]
}

export interface ArchiveRegistrySurface {
  archivedSessionIds?: readonly string[]
  pinnedSessionIds?: readonly string[]
  archiveSession?: (sessionId: string) => Promise<void>
  list?: () => WorkspaceEntryLike[]
  enqueueOperation?: (fn: () => Promise<void>) => Promise<void>
  requireState?: () => RegistryStateLike
  requireTable?: () => ArchiveTableSurface
  setState?: (state: unknown) => Promise<void>
  headers?: ReadonlyMap<string, unknown>
  sessionPaths?: ReadonlyMap<string, unknown>
  invalidSessionPaths?: ReadonlyMap<string, unknown>
  missingSessionPaths?: ReadonlySet<string>
}

export interface SessionHost {
  sessions: SessionStoreSurface
  agents?: AgentRegistrySurface
  workspaceRegistry: ArchiveRegistrySurface
  emit?: (event: string, ...args: unknown[]) => void
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
}
