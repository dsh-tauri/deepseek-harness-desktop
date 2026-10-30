import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID, SESSION_SECTION_ORDER } from '../../shared/constants'

export const SETTINGS_SECTION_SLOT = 'settings.section'
export const SESSION_REGISTRANT = PLUGIN_ID
export const SESSION_SECTION_ID = PLUGIN_ID

export const SESSION_MENU_STYLE_ID = `${PLUGIN_ID}-menu-styles`

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const STYLES_EFFECT = `${PLUGIN_ID}: styles`
export const ARCHIVE_SECTION_EFFECT = `${PLUGIN_ID}: archive section`
export const WORKSPACE_PATCH_EFFECT = `${PLUGIN_ID}: workspace archive patch`

export const ARCHIVE_RESYNC_TIMEOUT_MS = 2_000
export const SIDEBAR_ATTACH_POLL_MS = 500
export const SIDEBAR_ATTACH_MAX_TRIES = 30

export const DELETE_WORKSPACE_LABELS: readonly string[] = ['删除工作区', 'Delete workspace']

export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const TIMELINE_ROW_SELECTOR = '[role="treeitem"][aria-expanded]'
export const MENU_ITEM_SELECTOR = 'button[role="menuitem"]'
export const MENU_ITEM_WRAP_SELECTOR = '[class*="itemWrap"]'
export const MENU_ITEM_LABEL_SELECTOR = '[class*="itemLabel"]'
export const MENU_ITEM_ICON_SELECTOR = '[class*="itemIcon"]'

export const ARCHIVE_MENU_ITEM_ATTRIBUTE = 'data-dsh-tauri-session-archive-item'
export const ARCHIVE_MENU_PATCH_ATTRIBUTE = 'data-dsh-tauri-session-archive-menu-patched'
