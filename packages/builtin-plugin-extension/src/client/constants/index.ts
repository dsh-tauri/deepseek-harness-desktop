import type { LocaleKey } from '../locales/index.types'
import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID } from '../../shared/constants'

export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const PANEL_ID = PLUGIN_ID
export const PANEL_ACTION_ORDER = 20
export const PLUGINS_MORE_HEADER_SELECTOR = '[data-dsh-extension-plugins] [data-plugin-panel] > header:has(> button:first-child + h1)'
export const INPUT_PREFILL_ID = `${PLUGIN_ID}.skill-prefill`
export const INPUT_PREFILL_ORDER = 40
export const INPUT_PREFILL_PRIORITY = 0

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const SKILL_CREATOR_PREFILL_EFFECT = `${PLUGIN_ID}: skill creator prefill`
export const EXTENSION_PANEL_EFFECT = `${PLUGIN_ID}: extension panel`

export const SKILL_CREATOR_DRAFT = '/skill-creator '
export const SKILL_REFRESH_INTERVAL_MS = 300
export const SKILL_REFRESH_TIMEOUT_MS = 5_000
export const IMPORT_REFRESH_DELAYS_MS = [250, 750, 1_500] as const
export const MCP_RESTART_INITIAL_DELAY_MS = 3_000
export const MCP_RESTART_POLL_INTERVAL_MS = 1_500
export const MCP_RESTART_TIMEOUT_MS = 60_000
export const GITHUB_REPOSITORY_PATTERN = /^(?:https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/i

export const SOURCE_LOCALE_KEYS: Readonly<Record<string, LocaleKey>> = {
  'project-dsh': 'sourceProjectDsh',
  'project-agents': 'sourceProjectAgents',
  'user-dsh': 'sourceUserDsh',
  'user-agents': 'sourceUserAgents',
  'runtime': 'sourceRuntime',
  'bundled': 'sourceBundled',
  'custom': 'sourceCustom',
}
