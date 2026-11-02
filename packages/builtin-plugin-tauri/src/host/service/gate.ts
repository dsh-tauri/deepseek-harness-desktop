import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionHost } from '../types'
import process from 'node:process'
import { PLUGIN_ID } from '../../shared/constants'
import { defineService } from './index'

const EMBEDDED_ENV = 'DSH_TAURI_EMBEDDED'
const LAUNCH_TOKEN = 'token'

export const gate = defineService({
  attach(ctx: ConnectionHost): () => void {
    if (process.env[EMBEDDED_ENV] !== '1')
      return noop

    const { connection } = ctx
    if (connection === undefined || connection === null) {
      warn(ctx, '宿主实例缺少 connection 服务，桌面载体鉴权适配未生效')
      return noop
    }

    const restores: Array<() => void> = []
    if (connection.browserPeer !== undefined && typeof connection.admit === 'function') {
      const admit = connection.admit
      replace('admit', function (this: ConnectionHost['connection'], request: IncomingMessage) {
        const admission = admit.call(this, request)
        const peer = this.browserPeer
        return 'rejection' in admission && admission.rejection === 401 && this.disposed !== true && peer?.signal.aborted === false
          ? { peer }
          : admission
      })
    }

    // 带 token 的 index 请求必须交回内核：它负责 303 + Set-Cookie，把进程凭据换成
    // 浏览器会话 Cookie。桌面壳起服务后按这条响应种 Cookie，插件自建的 HTTP 路由
    // （浏览器插件 `/api/ego/*` 等）才拿得到凭证；其余请求维持内嵌载体的放行语义。
    if (typeof connection.authorizeIndex === 'function') {
      const authorizeIndex = connection.authorizeIndex
      replace('authorizeIndex', function (this: ConnectionHost['connection'], request: IncomingMessage, response: ServerResponse) {
        return hasLaunchToken(request) ? authorizeIndex.call(this, request, response) : true
      })
    }

    if (restores.length === 0)
      warn(ctx, 'connection 服务缺少 admit/authorizeIndex，桌面载体鉴权适配未生效')

    return () => {
      for (const restore of restores.splice(0).reverse())
        restore()
    }

    function replace(key: keyof ConnectionHost['connection'], value: unknown): void {
      let owner = connection
      while (!Object.hasOwn(owner, key))
        owner = Object.getPrototypeOf(owner) as typeof connection
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!
      Object.defineProperty(owner, key, { ...descriptor, value })
      restores.push(() => Object.defineProperty(owner, key, descriptor))
    }
  },
})

function noop(): void {}

/** 只认根路径上的 `token` 查询参数；内核的交换逻辑会自行校验取值。 */
function hasLaunchToken(request: IncomingMessage): boolean {
  if (request.method !== 'GET' || request.url === undefined)
    return false
  const url = URL.parse(request.url, 'http://dsh.invalid')
  return url?.pathname === '/' && url.searchParams.has(LAUNCH_TOKEN)
}

function warn(ctx: ConnectionHost, message: string): void {
  ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`)
}
