import type { Middleware } from 'h3'
import type { IncomingMessage } from 'node:http'
import type { ConnectionGate } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineEventHandler } from 'h3'

export const desktopRequestGuard: Middleware = async (event, next) => {
  const ctx = getServerContext(event)
  const request = event.runtime?.node?.req
  if (!request) {
    event.res.status = 403
    return { error: 'forbidden' }
  }
  const connection = ctx.connection as unknown as ConnectionGate | undefined
  const rejection = connection?.requestRejection?.(request as IncomingMessage)
  if (rejection !== undefined) {
    event.res.status = rejection
    return { error: rejection === 401 ? 'unauthorized' : 'forbidden' }
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.req.method)) {
    const address = request.socket.remoteAddress
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
      event.res.status = 403
      return { error: '变更操作仅限本机（127.0.0.1）调用' }
    }
    const origin = request.headers.origin
    if (origin !== undefined) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === request.headers.host
      }
      catch {}
      if (!sameOrigin) {
        event.res.status = 403
        return { error: 'cross-origin-request' }
      }
    }
  }
  try {
    return await next()
  }
  catch (error) {
    ctx.logger?.error(`[dsh-tauri] 路由处理失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    throw error
  }
}

export const desktopPreflight = defineEventHandler((event) => {
  const methods = new Set<string | undefined>(event.app?.['~routes'].map(route => route.method))
  if (methods.has('GET'))
    methods.add('HEAD')
  const allow = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter(method => methods.has(method)).join(', ')
  event.res.status = 204
  event.res.headers.set('allow', allow)
})
