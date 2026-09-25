import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { registerStyle } from './register/style'

export const name = PLUGIN_ID
/** 空注入：注入名是客户端服务、不是包名，本包不消费任何服务（跨包加载顺序由 package.json 的 `dsh.client.inject` 保证）。 */
export const inject: string[] = []

const STYLE_EFFECT = `${PLUGIN_ID}: styles`

export function apply(ctx: ClientContext): void {
  ctx.effect(registerStyle, STYLE_EFFECT)
}
