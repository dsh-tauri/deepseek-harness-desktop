import { REMOTE_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export { REMOTE_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SETTINGS_SECTION_ID = PLUGIN_ID
export const SETTINGS_SECTION_ORDER = 50

export const REMOTE_TAB_MACHINES = 'machines'
export const REMOTE_TAB_SYNC = 'sync'
export const REMOTE_TAB_ACCESS = 'access'
export const REMOTE_TABS_ID = 'dsh-tauri-remote-tabs'
export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

export const REMOTE_BRIDGE_PING_COMMAND = 'remote_bridge_ping'
export const REMOTE_OPEN_WINDOW_COMMAND = 'remote_open_window'

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const SECTION_EFFECT = `${PLUGIN_ID}: settings section`
export const POLL_EFFECT = `${PLUGIN_ID}: machine polling`
