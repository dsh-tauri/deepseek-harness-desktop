import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { HERO_WORKSPACE_EFFECT, IM_PANEL_EFFECT, LOCALE_EFFECT, NEW_SESSION_EFFECT, OBSTRUCTIONS_EFFECT, SECTIONS_EFFECT, SETTINGS_EFFECT, SETTINGS_OPEN_EFFECT, STYLES_EFFECT, UNGROUPED_NEW_SESSION_EFFECT } from './constants'
import { locale } from './locales'
import { composerResumeFeature } from './register/composer-resume'
import { registerContinueNotice } from './register/continue-notice'
import { heroWorkspaceFeature } from './register/hero-workspace'
import { registerImPanel } from './register/im-panel'
import { sidebarNewSessionFeature, ungroupedNewSessionFeature } from './register/new-session'
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
export type * from './store/modules/sections.types'
export type * from './store/modules/settings.types'
export * from './types/remotes'
export type * from './types/sections'
export type * from './types/selector'
export * from './utils/cssr'
export * from './utils/style'

export const name = PLUGIN_ID
export const inject = ['slots', 'layout', 'locale', 'sessions']

const COMPOSER_RESUME_EFFECT = `${PLUGIN_ID}: composer resume`
const CONTINUE_NOTICE_EFFECT = `${PLUGIN_ID}: continue notice`

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(registerStyles, STYLES_EFFECT)
  ctx.effect(registerSettingsSections, SECTIONS_EFFECT)
  ctx.effect(registerSettings, SETTINGS_EFFECT)
  ctx.effect(registerSettingsObstructions, OBSTRUCTIONS_EFFECT)
  ctx.effect(heroWorkspaceFeature, HERO_WORKSPACE_EFFECT)
  ctx.effect(sidebarNewSessionFeature, NEW_SESSION_EFFECT)
  ctx.effect(registerSettingsOpen, SETTINGS_OPEN_EFFECT)
  ctx.effect(ungroupedNewSessionFeature, UNGROUPED_NEW_SESSION_EFFECT)
  ctx.effect(composerResumeFeature, COMPOSER_RESUME_EFFECT)
  ctx.effect(registerContinueNotice, CONTINUE_NOTICE_EFFECT)
  ctx.effect(registerImPanel, IM_PANEL_EFFECT)
}
