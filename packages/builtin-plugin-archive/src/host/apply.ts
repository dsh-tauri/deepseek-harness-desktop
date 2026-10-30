import type { HostContext } from 'dsh-tauri'
import { PLUGIN_ID } from '../shared/constants'
import { server } from './server'

export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), `${PLUGIN_ID}: routes`)
}
