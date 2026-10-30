import type { McpTransport } from './mcp.types'

export interface ImportedServer {
  agent: 'claude-code' | 'codex' | 'cursor' | 'gemini'
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
