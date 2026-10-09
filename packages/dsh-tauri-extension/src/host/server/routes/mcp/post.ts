import type { EventHandlerRequest } from 'h3'
import type { ExtensionRouteDeps, McpSaveBody, McpSaveResponse } from '../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, readBody } from 'h3'
import { mcp } from '../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope, validateMcpInput } from '../../../service/mcp.utils'

export default defineEventHandler<EventHandlerRequest, Promise<McpSaveResponse | { error: string }>>(async (event) => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  const body = await readBody<McpSaveBody>(event, { type: 'json' })
  if (body === undefined) {
    event.res.status = 400
    return { error: 'invalid-body' }
  }
  try {
    const invalid = validateMcpInput(body)
    if (invalid !== null) {
      event.res.status = 400
      return { error: invalid }
    }
    const scope = normalizeMcpScope(body.scope)
    const id = mcp.save(mcpScopeDir(scope, deps.profileDirPath), body)
    return { ok: true, id, restartNeeded: !deps.hotReload() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
