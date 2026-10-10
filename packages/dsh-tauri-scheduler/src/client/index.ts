import type { ClientContext } from 'dsh-tauri/client'
import { AMBIENT_EFFECT, HYDRATE_EFFECT, LOCALE_EFFECT, PANEL_EFFECT, PLUGIN_ID, PREFILL_EFFECT, STYLES_EFFECT, TASK_TAB_EFFECT } from './constants'
import { locale } from './locales'
import { ambientFeature } from './register/ambient'
import { hydrateFeature } from './register/hydrate'
import { panelFeature } from './register/panel'
import { prefillFeature } from './register/prefill'
import { stylesFeature } from './register/styles'
import { taskTabFeature } from './register/task-tab'

export const name = PLUGIN_ID
export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(stylesFeature, STYLES_EFFECT)
  ctx.effect(hydrateFeature, HYDRATE_EFFECT)
  ctx.effect(panelFeature, PANEL_EFFECT)
  ctx.effect(prefillFeature, PREFILL_EFFECT)
  ctx.effect(taskTabFeature, TASK_TAB_EFFECT)
  ctx.effect(ambientFeature, AMBIENT_EFFECT)
}
