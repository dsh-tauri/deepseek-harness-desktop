import type { ClientContext } from 'dsh-tauri/client'
import {
  DIALOG_EFFECT,
  HYDRATION_EFFECT,
  LOCALE_EFFECT,
  MODE_SELECT_EFFECT,
  PLUGIN_ID,
  SESSION_ICONS_EFFECT,
  SURFACE_EFFECT,
} from './constants'
import { locale } from './locales'
import { dialogFeature } from './register/dialog'
import { hydrationFeature } from './register/hydration'
import { modeSelectFeature } from './register/mode-select'
import { sessionIconsFeature } from './register/session-icons'
import { surfaceFeature } from './register/surface'

export type * from './apis/index.type'
export type * from './store/modules/worktree.types'

export const name = PLUGIN_ID

export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(modeSelectFeature, MODE_SELECT_EFFECT)
  ctx.effect(surfaceFeature, SURFACE_EFFECT)
  ctx.effect(dialogFeature, DIALOG_EFFECT)
  ctx.effect(hydrationFeature, HYDRATION_EFFECT)
  ctx.effect(sessionIconsFeature, SESSION_ICONS_EFFECT)
}
