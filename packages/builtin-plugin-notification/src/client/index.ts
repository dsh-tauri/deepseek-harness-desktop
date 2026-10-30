import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { LOCALE_EFFECT, NOTIFY_EFFECT, SETTINGS_EFFECT } from './constants'
import { locale } from './locales'
import { notifyFeature } from './register/notify'
import { settingsFeature } from './register/settings'

export const name = PLUGIN_ID

/**
 * `uiSession` 不写进 inject：它在部分上下文里可能缺席，通知运行时用
 * `ctx.get('uiSession')` 探测并降级，而不是让整个插件卡在等待注入。
 */
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(settingsFeature, SETTINGS_EFFECT)
  ctx.effect(notifyFeature, NOTIFY_EFFECT)
}
