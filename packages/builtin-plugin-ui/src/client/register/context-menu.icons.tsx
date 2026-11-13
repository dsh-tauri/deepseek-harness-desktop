import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { ClientContext } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import { PLUGIN_ID } from '../../shared/constants'
import { Icon } from '../components/icon'
import { Archive, ArrowRightFromSquare, Copy, FolderOpen } from '../components/icons'

const CONTEXT_MENU_ICON_SLOT = 'contextMenu.icon'

const ICON_SIZE = 14

export const MENU_ICON_OPEN_IN_NEW_WINDOW = `${PLUGIN_ID}.open-in-new-window`
export const MENU_ICON_SHOW_IN_FOLDER = `${PLUGIN_ID}.show-in-folder`
export const MENU_ICON_COPY = `${PLUGIN_ID}.copy`
export const MENU_ICON_ARCHIVE = `${PLUGIN_ID}.archive`

const ICONS: Record<string, () => ReactElement> = {
  [MENU_ICON_OPEN_IN_NEW_WINDOW]: () => <Icon as={ArrowRightFromSquare} size={ICON_SIZE} />,
  [MENU_ICON_SHOW_IN_FOLDER]: () => <Icon as={FolderOpen} size={ICON_SIZE} />,
  [MENU_ICON_COPY]: () => <Icon as={Copy} size={ICON_SIZE} />,
  [MENU_ICON_ARCHIVE]: () => <Icon as={Archive} size={ICON_SIZE} />,
}

export function registerMenuIcons(ctx: ClientContext): () => void {
  const slots = ctx.slots
  if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    console.warn(`[${PLUGIN_ID}] 右键菜单图标不可用：缺少 slots 服务`)
    return () => {}
  }
  const disposers = Object.entries(ICONS).map(([key, render]) =>
    slots.inject(CONTEXT_MENU_ICON_SLOT as never, () =>
      slots.register({ name: CONTEXT_MENU_ICON_SLOT, key } as never, render as never)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
