import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { server } from './server'

const ROUTES_EFFECT = `${PLUGIN_ID}: routes`

export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), ROUTES_EFFECT)
}
