/** 路由请求体契约：生成客户端据此产出 `Types.*Body`（形状校验仍在处理器内做）。 */

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
