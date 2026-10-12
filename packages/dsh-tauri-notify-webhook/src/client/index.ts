import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { DELIVER_EFFECT, LOCALE_EFFECT, SECTION_EFFECT } from './constants'
import { locale } from './locales'
import { deliverFeature } from './register/deliver'
import { sectionFeature } from './register/section'

export const name = PLUGIN_ID

export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(sectionFeature, SECTION_EFFECT)
  ctx.effect(deliverFeature, DELIVER_EFFECT)
}
