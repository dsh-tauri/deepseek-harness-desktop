import type { Middleware } from 'h3'
import type { IncomingMessage } from 'node:http'
import type { ConnectionGate } from '../types'
import { getServerContext } from 'dsh-h3/utils'

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const guard: Middleware = async (event, next) => {
  const ctx = getServerContext(event)
  const req = event.runtime?.node?.req as IncomingMessage | undefined

  if (!req) {
    event.res.status = 403
    return { error: 'forbidden' }
  }

  const connection = ctx.connection as ConnectionGate | undefined
  const rejection = connection?.requestRejection?.(req)
  if (rejection !== undefined) {
    event.res.status = rejection
    return { error: rejection === 401 ? 'unauthorized' : 'forbidden' }
  }

  if (MUTATION_METHODS.has(event.req.method)) {
    if (!LOCALHOST_IPS.has(req.socket.remoteAddress ?? '')) {
      event.res.status = 403
      return { error: 'Change operation is limited to local machine (127.0.0.1) calls only' }
    }
    if (req.headers.origin !== undefined && URL.parse(req.headers.origin)?.host !== req.headers.host) {
      event.res.status = 403
      return { error: 'cross-origin-request' }
    }
  }

  try {
    return await next()
  }
  catch (error) {
    ctx.logger?.error(`[dsh-tauri] Routing processing failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    throw error
  }
}
