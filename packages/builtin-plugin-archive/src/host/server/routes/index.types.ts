export interface SessionIdBody {
  sessionId: string
}

export interface SessionIdsBody {
  sessionIds: string[]
}

export interface WorkspaceArchiveBody extends SessionIdsBody {
  workspaceId?: string
}

export interface OpenSessionDirResult {
  ok: boolean
  error?: string
}
