import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID } from '../../shared/constants'

export const INPUT_DOCK_SLOT = 'conversation.input.dock'
export const SHELL_OVERLAY_SLOT = 'shell.overlay'
export const MODE_SELECT_ID = `${PLUGIN_ID}-mode`
export const MODE_SELECT_ORDER = -20
export const SURFACE_ID = `${PLUGIN_ID}-surface`
export const SURFACE_ORDER = -10
export const DIALOG_ID = `${PLUGIN_ID}-dialog`

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const MODE_SELECT_EFFECT = `${PLUGIN_ID}: mode select slot`
export const SURFACE_EFFECT = `${PLUGIN_ID}: surface slot`
export const DIALOG_EFFECT = `${PLUGIN_ID}: dialog`
export const HYDRATION_EFFECT = `${PLUGIN_ID}: hydrate session bindings`
export const SESSION_ICONS_EFFECT = `${PLUGIN_ID}: session branch icons`

export const SESSION_SWITCH_RETRY_DELAY_MS = 100
export const SESSION_SWITCH_MAX_ATTEMPTS = 30

export const ATTACHMENT_READY_DELAY_MS = 100
export const ATTACHMENT_READY_MAX_ATTEMPTS = 100

export const HYDRATION_RETRY_DELAY_MS = 1500
export const HYDRATION_MAX_RETRIES = 30
export const HYDRATION_RETRY_WINDOW_MS = 10_000
export const HYDRATION_RETRY_BUDGET_PER_SECOND = 8
export const SESSION_RECONCILE_MIN_INTERVAL_MS = 1200
export const DISCARD_POLL_DELAY_MS = 500
export const DISCARD_MAX_POLLS = 120

export const HANDOFF_WINDOW_MS = 60_000

export const SESSION_ICON_ATTRIBUTE = 'data-dsh-worktree-icon'
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]'
export const COMPOSER_CARD_SELECTOR = '[data-composer-card="true"]'
export const HERO_PRESET_SLOT_SELECTOR = '[data-slot="conversation.hero.agentPreset"]'
export const COMPOSER_PLAN_SLOT_SELECTOR = '[data-slot="conversation.input.plan"]'
export const COMPOSER_MODE_BUTTON_SELECTOR = `${COMPOSER_CARD_SELECTOR} button[aria-label*="访问模式"], ${COMPOSER_CARD_SELECTOR} button[aria-label*="Access mode"]`
export const MODE_ANCHOR_ATTRIBUTE = 'data-dsh-tauri-worktree-mode-anchor'
