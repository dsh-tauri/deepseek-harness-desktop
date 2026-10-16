import type { HostContext } from 'dsh-tauri'
import type { McpCheckResult, McpRow } from './mcp.types'

export interface McpAuthBackend {
  check: (row: McpRow, timeoutMs: number) => Promise<McpCheckResult>
  start: (row: McpRow) => Promise<{ authorizationUrl: string, attemptId: string }>
  lookup: (attemptId: string) => { status: 'pending' | 'authorized' | 'error', error?: string } | undefined
}

export interface McpAuthModule {
  desktopMcpOAuth: (sdk: unknown, credentials: HostContext['credentials']) => McpAuthBackend
}
