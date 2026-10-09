import type { IncomingMessage } from 'node:http'
import type { ConnectionHost } from '../types'
import process from 'node:process'
import { PLUGIN_ID } from '../../shared/constants'
import { defineService } from './index'

/**
 * 桌面壳在 spawn 时注入的载体标记；与 `src-tauri/src/service/workflow/launch.rs` 的
 * envs 注入点逐字一致。未注入时本插件完全不接管鉴权，同一 profile 下独立运行的
 * `dsh web` 保持 browser-session 鉴权。
 */
const EMBEDDED_ENV = 'DSH_TAURI_EMBEDDED'

/**
 * 桌面载体鉴权适配。
 *
 * 内嵌 WebView 是 `tauri.localhost` 下的跨源沙箱 iframe，`SameSite=Strict` 的
 * browser-session Cookie 不会被携带，根路径 token 交换也就无法完成。这里在
 * `connection` 服务实例上覆写两道闸门：`requestRejection` 保留 Host/Origin fence
 * 的 403、只把 401 降级为放行；`authorizeIndex` 直接放行 index。
 *
 * 两道闸门必须**各自独立**接管：0.1.6 及更早两处都在 `connection` 上；0.1.7 起
 * `requestRejection` 移到了 peer 上，`connection` 只剩 `authorizeIndex`（且该方法
 * 会自行写出 401/303，返回 true 才是「调用方可以发 index.html」）。此前把两者绑成
 * 一个整体，缺一道就整个适配 noop —— 表现为嵌入 WebView 与健康探测都恒拿 401。
 */
export const gate = defineService({
  attach(ctx: ConnectionHost): () => void {
    if (process.env[EMBEDDED_ENV] !== '1') {
      return noop
    }

    const { connection } = ctx
    if (connection === undefined || connection === null) {
      warn(ctx, '宿主实例缺少 connection 服务，桌面载体鉴权适配未生效')
      return noop
    }

    const restores: Array<() => void> = []

    // `ctx.connection` 可能只是 cordis 的取用代理：只覆写实例属性时，赋值落在代理
    // 自身，`dsh-host-frontend-static` 里 `ctx.connection.authorizeIndex` 取到的仍是
    // 原型上的真方法（0.1.7 实测：无告警、覆写已装，401 照旧）。原型与实例一起接管，
    // detach 时逐条还原。
    const targets: ConnectionHost['connection'][] = [connection]
    const prototype = Object.getPrototypeOf(connection) as ConnectionHost['connection'] | null
    if (prototype !== null && prototype !== connection && prototype !== Object.prototype) {
      targets.push(prototype)
    }

    for (const target of targets) {
      const rejection = target.requestRejection
      if (typeof rejection === 'function') {
        target.requestRejection = (request: IncomingMessage) => {
          const rejected = rejection.call(target, request)
          return rejected === 401 ? undefined : rejected
        }
        restores.push(() => {
          target.requestRejection = rejection
        })
      }

      const authorize = target.authorizeIndex
      if (typeof authorize === 'function') {
        target.authorizeIndex = () => true
        restores.push(() => {
          target.authorizeIndex = authorize
        })
      }
    }

    if (restores.length === 0) {
      warn(ctx, 'connection 服务缺少 requestRejection/authorizeIndex，桌面载体鉴权适配未生效')
      return noop
    }

    return () => {
      for (const restore of restores) {
        restore()
      }
    }
  },
})

// --- internal ---

function noop(): void {}

function warn(ctx: ConnectionHost, message: string): void {
  ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`)
}
