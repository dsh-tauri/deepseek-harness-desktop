import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID } from '../../shared/constants'

export const PANEL_ID = PLUGIN_ID
export const PANEL_ACTION_ORDER = 30

export const CONVERSATION_INPUT_LEFT_SLOT = 'conversation.input.left'
export const INPUT_PREFILL_ID = `${PLUGIN_ID}.prefill`
export const INPUT_PREFILL_ORDER = 40
export const INPUT_PREFILL_PRIORITY = 0

export const STYLE_ID = `${PLUGIN_ID}-styles`
export const SCHEDULE_TASK_ID = `${PLUGIN_ID}/task`
export const SCHEDULE_TASK_KIND = 'scheduleTask'

export const REFRESH_INTERVAL_MS = 5_000

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const STYLES_EFFECT = `${PLUGIN_ID}: styles`
export const HYDRATE_EFFECT = `${PLUGIN_ID}: hydrate`
export const PANEL_EFFECT = `${PLUGIN_ID}: panel`
export const PREFILL_EFFECT = `${PLUGIN_ID}: prefill`
export const AMBIENT_EFFECT = `${PLUGIN_ID}: session schedules`
export const TASK_TAB_EFFECT = `${PLUGIN_ID}: task tabs`
