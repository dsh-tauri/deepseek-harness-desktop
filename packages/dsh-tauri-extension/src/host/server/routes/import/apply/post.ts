import type { EventHandlerRequest } from 'h3'
import type { McpInput } from '../../../../service/mcp.types'
import type { ExtensionRouteDeps, McpApplyImportResponse, McpImportApplyBody } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, readBody } from 'h3'
import { agents } from '../../../../service/agents'
import { mcp } from '../../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope, validateMcpInput } from '../../../../service/mcp.utils'

export default defineEventHandler<EventHandlerRequest, Promise<McpApplyImportResponse | { error: string }>>(async (event) => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  const body = await readBody<McpImportApplyBody>(event, { type: 'json' })
  try {
    const wanted = new Set(
      (Array.isArray(body?.items) ? body.items : [])
        .filter((item): item is { agent: string, name: string } =>
          typeof item === 'object' && item !== null && typeof (item as { agent?: unknown }).agent === 'string' && typeof (item as { name?: unknown }).name === 'string')
        .map(item => `${item.agent}/${item.name}`),
    )
    const dir = mcpScopeDir(normalizeMcpScope(body?.scope), deps.profileDirPath)
    const results: Array<{ name: string, ok: boolean, error?: string }> = []
    for (const server of agents.resolve()) {
      if (!wanted.has(`${server.agent}/${server.name}`))
        continue
      const existing = mcp.list(deps.profileDirPath).servers.some(row => row.serverName === server.name)
      if (existing) {
        results.push({ name: server.name, ok: false, error: 'already in profile' })
        continue
      }
      const input: McpInput = {
        id: '',
        serverName: server.name,
        transport: server.transport,
        ...(server.transport === 'stdio'
          ? { command: server.command, args: server.args, env: server.env }
          : { url: server.url, headers: server.headers }),
      }
      const invalid = validateMcpInput(input)
      if (invalid !== null) {
        results.push({ name: server.name, ok: false, error: invalid })
        continue
      }
      mcp.save(dir, input)
      results.push({ name: server.name, ok: true })
    }
    return { ok: results.every(item => item.ok), results, restartNeeded: !deps.hotReload() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
