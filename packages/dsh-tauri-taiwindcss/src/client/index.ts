import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { registerStyle } from './register/style'

export const name = PLUGIN_ID
export const inject = ['dsh-tauri', 'dsh-tauri-ui']

const STYLE_EFFECT = `${PLUGIN_ID}: styles`

export function apply(ctx: ClientContext): void {
  ctx.effect(registerStyle, STYLE_EFFECT)
}
