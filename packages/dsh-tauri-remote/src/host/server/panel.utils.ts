import type { EventHandler, EventHandlerRequest } from 'h3'
import type { IncomingMessage } from 'node:http'
import { defineEventHandler } from 'h3'
import { sourceSessionToken } from '../config/runtime'
import { isLoopbackSource } from '../utils/source'

export const LOOPBACK_ONLY_ERROR = '管理接口仅限本机回环来源'

/**
 * 面板写入口的来源门禁：非回环来源一律 403，且不进入 handler。
 *
 * 宿主 `guard` 只看 socket 地址，而入站暴露与公网隧道的请求都从回环上的网关转发进来，
 * 因此这里必须再按来源声明（转发头 / 网关会话）判定一次，否则公网来源能直接改本机暴露配置。
 */
export function loopbackOnly<Response>(handler: EventHandler<EventHandlerRequest, Response>): EventHandler<EventHandlerRequest, unknown> {
  return defineEventHandler<EventHandlerRequest, unknown>((event) => {
    const request = (event.runtime as { node?: { req?: IncomingMessage } } | undefined)?.node?.req
    if (request !== undefined && isLoopbackSource(request.headers, request.socket?.remoteAddress, sourceSessionToken()))
      return handler(event)
    event.res.status = 403
    return { error: LOOPBACK_ONLY_ERROR }
  })
}
