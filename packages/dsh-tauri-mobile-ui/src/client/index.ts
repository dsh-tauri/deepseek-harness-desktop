import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { locale } from './locales'
import { installBridgeConfig, registerBridgeConfig } from './register/bridge'
import { registerMobileKeyboard } from './register/keyboard'
import { registerMobilePreferences } from './register/preferences'
import { registerMobileSettings } from './register/settings'
import { registerMobileSidebar } from './register/sidebar'
import { registerStyles } from './register/styles'

export const name = PLUGIN_ID
export const inject = ['slots', 'layout', 'locale', 'sessions']

export function apply(ctx: ClientContext): void {
  installBridgeConfig()
  ctx.effect(registerBridgeConfig, `${PLUGIN_ID}: bridge`)
  ctx.effect(locale.registerLocale, `${PLUGIN_ID}: locale`)
  ctx.effect(registerStyles, `${PLUGIN_ID}: styles`)
  ctx.effect(registerMobileKeyboard, `${PLUGIN_ID}: keyboard`)
  ctx.effect(registerMobilePreferences, `${PLUGIN_ID}: preferences`)
  ctx.effect(registerMobileSidebar, `${PLUGIN_ID}: sidebar`)
  ctx.effect(registerMobileSettings, `${PLUGIN_ID}: settings`)
}
