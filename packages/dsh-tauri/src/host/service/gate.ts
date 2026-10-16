import type { IncomingMessage } from 'node:http'
import type { ConnectionHost } from '../types'
import process from 'node:process'
import { PLUGIN_ID } from '../../shared/constants'
import { defineService } from './index'

const EMBEDDED_ENV = 'DSH_TAURI_EMBEDDED'

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
    // issue #1083: alpha.3 admission owns authentication; older admit delegates to requestRejection.
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
    else if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection
      replace('requestRejection', function (this: ConnectionHost['connection'], request: IncomingMessage) {
        const rejected = rejection.call(this, request)
        return rejected === 401 ? undefined : rejected
      })
    }

    if (typeof connection.authorizeIndex === 'function')
      replace('authorizeIndex', () => true)

    if (restores.length === 0)
      warn(ctx, 'connection 服务缺少 admit/requestRejection/authorizeIndex，桌面载体鉴权适配未生效')

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

function warn(ctx: ConnectionHost, message: string): void {
  ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`)
}
