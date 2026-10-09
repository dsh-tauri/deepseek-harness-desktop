import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { handlePreStep } from './events/pre-step'
import { server } from './server'

const ROUTES_EFFECT = `${PLUGIN_ID}: routes`

export function apply(ctx: HostContext): void {
  ctx.on('agent/pre-step', handlePreStep)

  ctx.effect(() => server(ctx), ROUTES_EFFECT)
}
