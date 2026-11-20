import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { CONTEXT_MENU_EFFECT, LOCALE_EFFECT, OBSTRUCTIONS_EFFECT, SECTIONS_EFFECT, SETTINGS_EFFECT, SETTINGS_OPEN_EFFECT, STYLES_EFFECT } from './constants'
import { locale } from './locales'
import { registerContextMenu } from './register/context-menu'
import { registerMenuIcons } from './register/context-menu.icons'
import { registerDesktopSettings } from './register/desktop-settings'
import { registerSettingsObstructions } from './register/obstructions'
import { registerSettingsSections } from './register/sections'
import { registerSettings } from './register/settings'
import { registerSettingsOpen } from './register/settings-open'
import { registerStyles } from './register/styles'

export * from './components'
export * from './components/panel'
export * from './components/segmented-control'
export * from './constants/theme'
export * from './hooks/use-mount-style'
export * from './register/slot-decoration'
export type * from './store/modules/sections.types'
export type * from './store/modules/settings.types'
export * from './types/remotes'
export type * from './types/sections'
export type * from './types/selector'
export * from './utils/cssr'
export * from './utils/style'

export const name = PLUGIN_ID
export const inject = ['slots', 'layout', 'locale', 'sessions', 'uiSession', 'uiWorkspace', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(registerStyles, STYLES_EFFECT)
  ctx.effect(registerSettingsSections, SECTIONS_EFFECT)
  ctx.effect(registerSettings, SETTINGS_EFFECT)
  ctx.effect(registerSettingsObstructions, OBSTRUCTIONS_EFFECT)
  ctx.effect(registerSettingsOpen, SETTINGS_OPEN_EFFECT)
  ctx.effect(() => registerMenuIcons(ctx), `${CONTEXT_MENU_EFFECT} icons`)
  ctx.effect(() => registerContextMenu(ctx), CONTEXT_MENU_EFFECT)
  ctx.effect(registerDesktopSettings, `${PLUGIN_ID}: desktop settings`)
}
