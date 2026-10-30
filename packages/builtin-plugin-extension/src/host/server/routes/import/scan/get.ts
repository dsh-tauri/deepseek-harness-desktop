import type { ExtensionRouteDeps, McpImportScanResponse } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler } from 'h3'
import { agents } from '../../../../service/agents'
import { mcp } from '../../../../service/mcp'

export default defineEventHandler((event): McpImportScanResponse | { error: string } => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  try {
    return {
      servers: agents.resolve(),
      existing: mcp.list(deps.profileDirPath).servers.map(row => row.serverName),
    }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
