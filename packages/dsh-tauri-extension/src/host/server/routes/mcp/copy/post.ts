import type { ExtensionRouteDeps } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, readBody } from 'h3'
import { mcp } from '../../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope } from '../../../../service/mcp.utils'

interface McpCopyBody { id?: unknown, scope?: unknown, toScope?: unknown }

export default defineEventHandler(async (event) => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  const body = await readBody<McpCopyBody>(event, { type: 'json' })
  if (typeof body?.id !== 'string') {
    event.res.status = 400
    return { error: 'id is required' }
  }
  const id = body.id
  try {
    const sourceDir = mcpScopeDir(normalizeMcpScope(body.scope), deps.profileDirPath)
    const scope = normalizeMcpScope(body.toScope)
    const createdId = mcp.copy(sourceDir, mcpScopeDir(scope, deps.profileDirPath), id)
    if (createdId === undefined) {
      event.res.status = 404
      return { error: 'server row not found' }
    }
    return { ok: true, id: createdId, scope, restartNeeded: !deps.hotReload() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
