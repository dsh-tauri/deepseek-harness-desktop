import type { HostContext } from 'dsh-tauri'
import { resetRuntime } from './config/runtime'
import { server } from './server'

const PET_ROUTES_EFFECT = 'dsh-tauri-pet: routes'

const PET_HOST_RUNTIME_EFFECT = 'dsh-tauri-pet: host runtime'

/**
 * host/apply.ts — 桌宠宿主侧装配。
 *
 * 方案 1（host → rust → pet webview）：宿主把 `session/event`【增量】总线状态化重建为
 * 桌宠展示态后，经 HTTP SSE 流发布；Rust 用 reqwest 订阅该流并 `emit_to('pet')`。
 */
export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), PET_ROUTES_EFFECT)
  ctx.effect(() => () => resetRuntime(), PET_HOST_RUNTIME_EFFECT)
}
