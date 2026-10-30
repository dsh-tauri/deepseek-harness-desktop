export type AdapterRuntimeObject = Record<string, unknown>
export type AdapterSessionId = string
export type AdapterWorkspaceId = string
export type AdapterGeneration = 'modern' | 'unknown'

export interface AdapterListProjection<TSnapshot = unknown> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => TSnapshot
}

export interface AdapterSessionCreateOptions {
  workspaceId?: AdapterWorkspaceId
  cwd?: string
  sessionId?: AdapterSessionId
}

export interface AdapterSessions extends AdapterRuntimeObject {
  list?: AdapterListProjection
  getSnapshot?: () => unknown
  subscribe?: (listener: () => void) => () => void
  provideInfo?: (sessionId: AdapterSessionId) => unknown
  binding?: (sessionId: AdapterSessionId) => unknown
  create?: (options?: AdapterSessionCreateOptions) => Promise<AdapterSessionId>
  refreshProjections?: (sessionId: AdapterSessionId) => Promise<void>
  refresh?: () => unknown
  open?: (sessionId: AdapterSessionId) => unknown
  fork?: (...args: unknown[]) => unknown
}

export interface AdapterWorkspaces extends AdapterRuntimeObject {
  list?: AdapterListProjection
  create?: (input: { path: string }) => Promise<{ workspaceId: AdapterWorkspaceId } & AdapterRuntimeObject>
  startSession?: (workspaceId?: AdapterWorkspaceId) => unknown
  connectWorkspace?: (workspaceId: AdapterWorkspaceId) => unknown
  archiveSession?: (...args: unknown[]) => unknown
  delete?: (...args: unknown[]) => unknown
}

export interface AdapterAddWorkspaceRuntime {
  pickDirectory: () => Promise<string | null | undefined>
  createWorkspace: (input: { path: string }) => Promise<{ workspaceId: AdapterWorkspaceId }>
  startSession: (workspaceId: AdapterWorkspaceId) => unknown
}

export interface AdapterSessionList {
  ids: readonly AdapterSessionId[]
  current?: AdapterSessionId
  subscribe: (listener: () => void) => () => void
}

export type AdapterStartSession = (workspaceId?: AdapterWorkspaceId) => unknown
export type AdapterOpenSession = (sessionId: AdapterSessionId) => unknown

export interface AdapterProbe {
  service: <T = AdapterRuntimeObject>(name: string) => T | undefined
  generation: AdapterGeneration
}

export interface AdapterSurface {
  sessions?: AdapterSessions
  workspaces?: AdapterWorkspaces
  uiWorkspace?: AdapterRuntimeObject
  uiSession?: AdapterRuntimeObject
  startSession?: AdapterStartSession
  openSession?: AdapterOpenSession
  addWorkspace?: AdapterAddWorkspaceRuntime
}

export interface DshMigration {
  id: string
  description?: string
  detect: (probe: AdapterProbe, surface: AdapterSurface) => boolean
  apply: (surface: AdapterSurface, probe: AdapterProbe) => void
}

export interface AdapterMigrationFailure {
  migration: string
  error: unknown
}

export type AdapterCapability
  = | 'sessions.list'
    | 'sessions.provideInfo'
    | 'sessions.create'
    | 'sessions.refresh'
    | 'sessions.refreshProjections'
    | 'workspaces.list'
    | 'workspaces.create'
    | 'navigation.startSession'
    | 'navigation.openSession'
    | 'navigation.addWorkspace'
    | 'composer.workspace-less'
    | 'dom.newSession'
    | 'dom.addWorkspace'

export type AdapterStartSessionOutcome
  = | { status: 'started', value: unknown }
    | { status: 'delegated' }
    | { status: 'unavailable', reason: string }

export type AdapterOpenSessionOutcome
  = | { status: 'opened', value: unknown }
    | { status: 'unavailable', reason: string }

export type AdapterAddWorkspaceOutcome
  = | { status: 'created', workspaceId: AdapterWorkspaceId, path: string, sessionStarted: boolean }
    | { status: 'cancelled' }
    | { status: 'delegated' }
    | { status: 'unavailable', reason: string }

export interface AdapterAddWorkspaceOptions {
  openSession?: boolean
}

export interface AdapterContext extends AdapterRuntimeObject {
  sessions?: AdapterSessions
  workspaces?: AdapterWorkspaces
}

export interface ClientAdapter {
  readonly generation: AdapterGeneration
  readonly migrations: readonly string[]
  readonly failures: readonly AdapterMigrationFailure[]
  readonly ctx: AdapterContext
  readonly sessions: AdapterSessions
  readonly workspaces: AdapterWorkspaces
  service: <T = AdapterRuntimeObject>(name: string) => T | undefined
  has: (capability: AdapterCapability) => boolean
  resolveStartSession: () => AdapterStartSession | undefined
  resolveOpenSession: () => AdapterOpenSession | undefined
  sessionList: () => AdapterSessionList | undefined
  resolveAddWorkspace: () => AdapterAddWorkspaceRuntime | undefined
  startSession: (workspaceId?: AdapterWorkspaceId) => Promise<AdapterStartSessionOutcome>
  openSession: (sessionId: AdapterSessionId) => AdapterOpenSessionOutcome
  addWorkspace: (options?: AdapterAddWorkspaceOptions) => Promise<AdapterAddWorkspaceOutcome>
}

export interface DefineAdapterOptions {
  migrations?: readonly DshMigration[]
  onWarn?: (message: string, error?: unknown) => void
}
