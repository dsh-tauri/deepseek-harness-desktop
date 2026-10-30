import type { HostContext } from 'dsh-tauri'
import type { McpAuthBackend, McpAuthModule } from './mcp-auth.types'
import type { McpCheckResult, McpRow } from './mcp.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { mcpAuthRuntime } from '../config/runtime'
import { server } from '../server'

export const mcpAuth = defineService({
  async check(row: McpRow, timeoutMs: number): Promise<McpCheckResult> {
    try {
      return await (await resolveBackend()).check(row, timeoutMs)
    }
    catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  },
  async start(row: McpRow): Promise<{ authorizationUrl: string, attemptId: string }> {
    return (await resolveBackend()).start(row)
  },
  lookup(attemptId: string): ReturnType<McpAuthBackend['lookup']> {
    return mcpAuthRuntime.backend?.lookup(attemptId)
  },
})

async function resolveBackend(): Promise<McpAuthBackend> {
  const host = getServerContext<HostContext>(server)
  const core = await host.loader.import('@deepseek-ai/dsh-mcp-client')
  const module = host.loader.unwrapExports(core) as McpAuthModule
  if (typeof module.desktopMcpOAuth !== 'function')
    throw new Error('MCP OAuth requires the current DSH core; update the core in DSH Desktop and restart')
  const sdk = await host.loader.import('@modelcontextprotocol/client')
  return mcpAuthRuntime.backend = module.desktopMcpOAuth(host.loader.unwrapExports(sdk), host.credentials)
}
