import type { HostContext } from 'dsh-tauri'
import type { McpAuthBackend, McpAuthCredentialStore, McpOAuthSdk } from './mcp-auth.types'
import type { McpCheckResult, McpRow } from './mcp.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { mcpAuthRuntime } from '../config/runtime'
import { server } from '../server'
import { createMcpAuthBackend } from './mcp-auth.backend'
import { onceAsync } from './mcp-auth.utils'

type CredentialKey = Parameters<HostContext['credentials']['readRecord']>[0]

async function loadBackend(): Promise<McpAuthBackend> {
  const host = getServerContext<HostContext>(server)
  const sdk = await host.loader.import('@modelcontextprotocol/client')
  return mcpAuthRuntime.backend = createMcpAuthBackend(
    host.loader.unwrapExports(sdk) as McpOAuthSdk,
    credentialStore(host.credentials),
  )
}

const resolveBackend = onceAsync(loadBackend)

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

function credentialStore(credentials: HostContext['credentials']): McpAuthCredentialStore {
  return {
    readRecord: key => credentials.readRecord(key as CredentialKey),
    modifyRecord: (key, mutate) => credentials.modifyRecord(key as CredentialKey, async current => mutate(current)),
  }
}
