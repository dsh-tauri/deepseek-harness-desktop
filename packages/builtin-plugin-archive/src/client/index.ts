import type { ClientContext } from 'dsh-tauri/client'
import { ARCHIVE_SECTION_EFFECT, LOCALE_EFFECT, PLUGIN_ID } from './constants'
import { locale } from './locales'
import { archiveSectionFeature } from './register/archive-section'

export const name = PLUGIN_ID

export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(archiveSectionFeature, ARCHIVE_SECTION_EFFECT)
}
