import type { ClientContext } from 'dsh-tauri/client'
import { CONTEXT_MENU_EFFECT, LOCALE_EFFECT, PLUGIN_ID } from './constants'
import { locale } from './locales'
import { contextMenuFeature } from './register/context-menu'

export const name = PLUGIN_ID

export const inject = ['locale', 'sessions', 'workspaces', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(contextMenuFeature, CONTEXT_MENU_EFFECT)
}
