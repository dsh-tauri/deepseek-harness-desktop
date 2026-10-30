import type { EventHandlerRequest } from 'h3'
import type { ExtensionRouteDeps, McpCheckBody } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, readBody } from 'h3'
import { mcp } from '../../../../service/mcp'
import { mcpAuth } from '../../../../service/mcp-auth'
import { mcpScopeDir, normalizeMcpScope } from '../../../../service/mcp.utils'

export default defineEventHandler<EventHandlerRequest, Promise<{ authorizationUrl: string, attemptId: string } | { error: string }>>(async (event) => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  const body = await readBody<McpCheckBody>(event, { type: 'json' })
  if (typeof body?.id !== 'string' || (body.scope !== undefined && body.scope !== 'global' && body.scope !== 'profile')) {
    event.res.status = 400
    return { error: 'id and valid scope are required' }
  }
  try {
    const dir = mcpScopeDir(normalizeMcpScope(body.scope), deps.profileDirPath)
    const row = mcp.peek(dir).find(item => item.id === body.id)
    if (row === undefined) {
      event.res.status = 404
      return { error: 'server row not found' }
    }
    if (row.transport !== 'streamable-http') {
      event.res.status = 400
      return { error: 'only HTTP MCP servers support authorization' }
    }
    return await mcpAuth.start(row)
  }
  catch (error) {
    const expected = error instanceof Error && 'code' in error && error.code === 'MCP_OAUTH_START_FAILED'
    event.res.status = expected ? 422 : 500
    return { error: expected ? error.message : 'MCP OAuth authorization could not start' }
  }
})
