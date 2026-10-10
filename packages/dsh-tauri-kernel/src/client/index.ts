import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { locale } from './locales'
import { kernel } from './register/kernel'

export const name = PLUGIN_ID
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, `${PLUGIN_ID}: locale`)
  ctx.effect(kernel, `${PLUGIN_ID}: kernel`)
}
