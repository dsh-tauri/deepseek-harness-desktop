import type { ExtensionRouteDeps, McpListResponse } from '../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler } from 'h3'
import { mcp } from '../../../service/mcp'

export default defineEventHandler((event): McpListResponse | { error: string } => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  return { ...mcp.list(deps.profileDirPath), restartNeeded: !deps.hotReload() }
})
