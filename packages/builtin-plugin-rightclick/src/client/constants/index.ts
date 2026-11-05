import { PLUGIN_ID } from '../../shared/constants'

export { PLUGIN_ID } from '../../shared/constants'

export const LOCALE_EFFECT = `${PLUGIN_ID}: locale`
export const CONTEXT_MENU_EFFECT = `${PLUGIN_ID}: context menu`

export const TREE_ITEM_SELECTOR = '[role="treeitem"]'
export const TREE_ITEM_EXPANDED_SELECTOR = '[role="treeitem"][aria-expanded]'
export const ACTION_BUTTON_SELECTOR = 'button[aria-label]'
export const LINK_SELECTOR = 'a[href]'
export const MENU_ITEM_SELECTOR = '[role="menuitem"]'
export const EDITABLE_SELECTOR = 'input:not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]'
export const CONVERSATION_SELECTOR = '[data-slot="conversation.session"]'
export const DIALOG_SELECTOR = '[role="dialog"]'
export const HERO_SELECTOR = '[data-phase="hero"]'
export const CONVERSATION_SCROLL_SELECTOR = ':scope > [data-conversation-scroll]'

export const EXTENSIONS_REGISTRY_KEY = 'dsh.rightclick-menu.extensions'
export const CONTEXT_MENU_EVENT = 'dsh:rightclick-menu'

export const TOAST_DURATION_MS = 1800
