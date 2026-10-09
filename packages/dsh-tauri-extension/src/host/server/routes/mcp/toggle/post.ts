import type { EventHandlerRequest } from 'h3'
import type { ExtensionRouteDeps, McpActionResult, McpToggleBody } from '../../index.types'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, readBody } from 'h3'
import { mcp } from '../../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope } from '../../../../service/mcp.utils'

export default defineEventHandler<EventHandlerRequest, Promise<McpActionResult | { error: string }>>(async (event) => {
  const deps = getServerOptions<ExtensionRouteDeps>(event)
  const body = await readBody<McpToggleBody>(event, { type: 'json' })
  if (typeof body?.id !== 'string' || typeof body.disabled !== 'boolean') {
    event.res.status = 400
    return { error: 'id and disabled are required' }
  }
  const id = body.id
  const disabled = body.disabled
  try {
    const ok = mcp.toggle(mcpScopeDir(normalizeMcpScope(body.scope), deps.profileDirPath), id, disabled)
    if (!ok) {
      event.res.status = 404
      return { error: 'server row not found' }
    }
    return { ok: true, restartNeeded: !deps.hotReload() }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
