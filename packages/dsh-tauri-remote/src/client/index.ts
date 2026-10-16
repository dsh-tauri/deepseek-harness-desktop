import type { ClientContext } from 'dsh-tauri/client'
import { LOCALE_EFFECT, PLUGIN_ID, POLL_EFFECT, SECTION_EFFECT } from './constants/index'
import { locale } from './locales/index'
import { pollFeature } from './register/poll'
import { sectionFeature } from './register/section'

export type { RemoteKey } from './locales/index'

export const name = PLUGIN_ID

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(sectionFeature, SECTION_EFFECT)
  ctx.effect(pollFeature, POLL_EFFECT)
}
