import type { ClientContext } from 'dsh-tauri/client'
import {
  LOCALE_EFFECT,
  MCP_SECTION_EFFECT,
  PLUGIN_ID,
  SKILL_CREATOR_PREFILL_EFFECT,
  SKILLS_SECTION_EFFECT,
} from './constants'
import { locale } from './locales'
import { mcpSectionFeature } from './register/mcp-section'
import { skillCreatorPrefillFeature } from './register/skill-creator-prefill'
import { skillsSectionFeature } from './register/skills-section'

export const name = PLUGIN_ID

export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, LOCALE_EFFECT)
  ctx.effect(skillCreatorPrefillFeature, SKILL_CREATOR_PREFILL_EFFECT)
  ctx.effect(skillsSectionFeature, SKILLS_SECTION_EFFECT)
  ctx.effect(mcpSectionFeature, MCP_SECTION_EFFECT)
}
