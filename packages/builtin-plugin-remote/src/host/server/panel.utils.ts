import type { Middleware } from 'h3'
import type { IncomingMessage } from 'node:http'
import { sourceSessionToken } from '../config/runtime'
import { session } from '../service/session'
import { isLoopbackSource } from '../utils/source'

export const LOOPBACK_ONLY_ERROR = '管理接口仅限本机回环来源'

export function isLocalRequest(event: { runtime?: unknown }): boolean {
  const request = (event.runtime as { node?: { req?: IncomingMessage } } | undefined)?.node?.req
  return request !== undefined && !session.role().remote
    && isLoopbackSource(request.headers, request.socket?.remoteAddress, sourceSessionToken())
}

export const remoteSourceGuard: Middleware = async (event, next) => {
  if (isLocalRequest(event) || ((event.req.method === 'GET' || event.req.method === 'HEAD') && event.url.pathname === '/api/tauri/remote/session/role'))
    return next()
  event.res.status = 403
  return { error: LOOPBACK_ONLY_ERROR }
}
