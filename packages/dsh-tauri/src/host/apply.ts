import type { ConnectionHost, HostContext } from './types'
import process from 'node:process'
import { PLUGIN_ID } from '../shared/constants'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { gate } from './service/gate'
import { webFetch } from './service/web-fetch'

const GATE_EFFECT = `${PLUGIN_ID}: gate`
const ACCOUNT_EFFECT = `${PLUGIN_ID}: account desktop marker`
const WEB_FETCH_EFFECT = `${PLUGIN_ID}: web fetch`
const HOST_RUNTIME_EFFECT = `${PLUGIN_ID}: host runtime`

/**
 * 官方账号 UI 只认 `'dshDesktop' in globalThis`（`dsh-client-ui-settings-account` 的
 * `apply()` 早退判据），而唯一的“我是桌面载体”凭据是壳层给 iframe 加的 `dshDesktop`
 * 查询参数（见 `src/store/modules/harness/utils.ts`）。写成解析期即执行的经典脚本，
 * 保证在任何模块插件 `apply()` 之前落位；用户用浏览器直开同一端口时不带该参数，
 * 因而不会误开账号入口。
 *
 * 取值与官方 preload 的非 app 来源分支一致（`{ protocolVersion: 1 }`，见
 * `apps/desktop/src/preload-app.ts`）：只声明载体，**不伪造** Electron 的产品 API
 * （`updates` / `browser`），消费方都是 `carrier?.protocolVersion === 1 ? carrier.updates : undefined`
 * 这样的可选链。
 *
 * 官方 0.2.0 为反馈表单新增了可选 `dshDesktop.deviceInfo()`（`apps/desktop/src/device-info.ts`
 * 输出 `platform=…; os=…; app_arch=…; cpu=…; memory_gib=…`）。Tauri 侧不探测硬件，
 * 只回退到官方缺失该能力时的同一份取值 `navigator.userAgent`，让表单拿到非空预填。
 */
const ACCOUNT_MARKER_SCRIPT = 'if (new URLSearchParams(location.search).has(\'dshDesktop\')) globalThis.dshDesktop = { protocolVersion: 1, deviceInfo: async () => navigator.userAgent };'

export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx as unknown as ConnectionHost)

  ctx.effect(() => gate.attach(), GATE_EFFECT)
  ctx.effect(() => webFetch.attach(), WEB_FETCH_EFFECT)
  if (process.env.DSH_TAURI_EMBEDDED === '1') {
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: ACCOUNT_MARKER_SCRIPT })
    }), ACCOUNT_EFFECT)
  }
  ctx.effect(() => () => clearHostRuntime(), HOST_RUNTIME_EFFECT)
}
