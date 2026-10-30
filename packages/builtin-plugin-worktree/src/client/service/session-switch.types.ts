export interface InputState {
  draft: string
  imageIds?: string[]
  attachmentIds?: string[]
}

export interface InputActions {
  setDraft: (text: string) => void
  persistDraft?: () => void
  addImages?: (ids: string[]) => boolean
  removeImage?: (id: string) => void
  addAttachments?: (ids: string[]) => boolean
  removeAttachment?: (id: string) => void
  submit: () => void
}

export interface DraftReference {
  readonly source: string
  readonly ref: string
  readonly offset: number
  readonly length: number
  readonly label: string
  readonly clipboardText: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly invalid?: boolean
}

export interface SessionDraft {
  readonly text: string
  readonly references: readonly DraftReference[]
}

export interface SessionInputRuntime {
  readonly draftSnapshot?: SessionDraft
  setDraft: (draft: string | SessionDraft) => void
}

export interface SessionListSnapshot {
  ids: string[]
  current?: string
}

export interface SessionsRuntime {
  create: (opts: { cwd: string, sessionId: string }) => Promise<string>
  open: (sessionId: string) => void
  binding?: (sessionId: string) => { ctx?: unknown } | undefined
  provideInfo?: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
  refresh: () => Promise<void>
  list: {
    getSnapshot: () => SessionListSnapshot
    subscribe: (listener: () => void) => () => void
  }
}

export interface WorkspacesRuntime {
  archiveSession: (sessionId: string) => Promise<void>
  list: { getSnapshot: () => { items: WorkspaceSessionOrder[] } }
  insertSessionBefore: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<unknown>
}

export interface WorkspaceSessionOrder {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

export type Wait = (ms: number) => Promise<void>

export type SwitchOutcome = 'switched' | 'aborted' | 'retry'

export interface ListSessions {
  refresh: () => Promise<void>
  list: { getSnapshot: () => SessionListSnapshot }
}

export interface InputSessions extends ListSessions {
  provideInfo?: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
}

export interface SwitchSessions {
  open: (sessionId: string) => void
  refresh: () => Promise<void>
  list: { getSnapshot: () => SessionListSnapshot }
}
