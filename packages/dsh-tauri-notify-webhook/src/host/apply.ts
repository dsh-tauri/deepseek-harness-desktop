import type { HostContext } from 'dsh-tauri'
import { PLUGIN_ID } from '../shared/constants'
import { resetRuntime } from './config/runtime'
import { handleSessionEvent } from './events/session-event'
import { server } from './server'

export function apply(ctx: HostContext): void {
  ctx.on('session/event', handleSessionEvent)

  ctx.effect(() => server(ctx), `${PLUGIN_ID}: routes`)
  ctx.effect(() => () => resetRuntime(), `${PLUGIN_ID}: host runtime`)
}
