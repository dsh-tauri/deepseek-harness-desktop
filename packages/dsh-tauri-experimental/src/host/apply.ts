/**
 * host/apply.ts — running-changes 插件装配（声明式接线，无业务逻辑）。
 *
 * 事件处理器的实现在 `events/`：宿主能力只经 `service/` 间接访问，装配层不传 deps 对象。
 */

import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { disposeRuntime, resetHostRuntime } from './config/runtime'
import { handleAgentStatus } from './events/agent-status'
import { handlePreStep } from './events/pre-step'
import { handleSessionDisposed } from './events/session-disposed'
import { handleSessionEvent } from './events/session-event'
import { handlePreExecute } from './events/tools-pre-execute'
import { server } from './server'
import { capture } from './service/capture'

export function apply(ctx: HostContext): void {
  resetHostRuntime()
  ctx.effect(() => server(ctx), `${PLUGIN_ID}: routes`)

  ctx.on('agent/pre-step', handlePreStep)
  ctx.on('tools/pre-execute', handlePreExecute)
  ctx.on('session/event', handleSessionEvent)
  ctx.on('agent/status', handleAgentStatus)
  ctx.on('session/disposed', handleSessionDisposed)

  ctx.effect(() => () => capture.dispose(), `${PLUGIN_ID}: turn capture`)
  ctx.effect(() => () => disposeRuntime(), `${PLUGIN_ID}: host runtime`)
}
