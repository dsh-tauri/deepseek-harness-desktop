export type McpTransport = 'stdio' | 'streamable-http'

export type McpScope = 'global' | 'profile'

export interface McpRow {
  id: string
  serverName: string
  transport: McpTransport
  disabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface McpRowView extends McpRow {
  scope: McpScope
  shadowed?: boolean
}

export interface McpListResult {
  servers: McpRowView[]
  globalError?: string
}

export type McpInput = Omit<McpRow, 'disabled'> & { disabled?: boolean }

export interface McpCheckResult {
  ok: boolean
  detail?: string
  requiresAuth?: boolean
}

export interface McpCheckOptions {
  timeoutMs?: number
  pathEnv?: string
  platform?: string
}
