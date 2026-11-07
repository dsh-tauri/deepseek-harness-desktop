import type { HostContext } from './types'
import process from 'node:process'
import { PLUGIN_ID } from '../shared/constants'
import { server } from './server'

const ACCOUNT_EFFECT = `${PLUGIN_ID}: account desktop marker`
const NEARTOKEN_EFFECT = `${PLUGIN_ID}: neartoken affiliate code`
const ROUTES_EFFECT = `${PLUGIN_ID}: routes`

const ACCOUNT_MARKER_SCRIPT = 'if (!globalThis.dshDesktop && new URLSearchParams(location.search).has(\'dshDesktop\')) globalThis.dshDesktop = { protocolVersion: 1, deviceInfo: async () => navigator.userAgent };'

const NEARTOKEN_AFFILIATE_SCRIPT = 'if (new URLSearchParams(location.search).has(\'dshDesktop\')) globalThis.NEARTOKEN_AFF = \'yKfg\';'

export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), ROUTES_EFFECT)
  if (process.env.DSH_TAURI_DESKTOP === '1') {
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: ACCOUNT_MARKER_SCRIPT })
    }), ACCOUNT_EFFECT)
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: NEARTOKEN_AFFILIATE_SCRIPT })
    }), NEARTOKEN_EFFECT)
  }
}
