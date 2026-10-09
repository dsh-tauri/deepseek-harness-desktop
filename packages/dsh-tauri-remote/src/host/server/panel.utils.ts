import type { Middleware } from 'h3'
import type { IncomingMessage } from 'node:http'
import { sourceSessionToken } from '../config/runtime'
import { isLoopbackSource } from '../utils/source'

export const LOOPBACK_ONLY_ERROR = '管理接口仅限本机回环来源'

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 面板写入口的来源门禁。
 *
 * 宿主 `guard` 只看 socket 地址，而入站暴露与公网隧道的请求都从回环上的网关转发进来，
 * 因此这里必须再按来源声明（转发头 / 网关会话）判定一次，否则公网来源能直接改本机暴露配置。
 * 读方法放行：非回环来源由 handler 返回脱敏后的状态。
 */
export const remoteSourceGuard: Middleware = async (event, next) => {
  const request = (event.runtime as { node?: { req?: IncomingMessage } } | undefined)?.node?.req
  if (MUTATION_METHODS.has(event.req.method) && (request === undefined || !isLoopbackSource(request.headers, request.socket?.remoteAddress, sourceSessionToken()))) {
    event.res.status = 403
    return { error: LOOPBACK_ONLY_ERROR }
  }
  return next()
}
