import type { ClientContext } from 'dsh-tauri/client'
import { detectMobileDevice, invoke } from 'dsh-tauri/client'
import { locale } from '../locales'

interface SessionTarget {
  sessionId: string
}

interface MenuActionItem {
  id: string
  label: string
  disabled?: boolean
  separatorBefore?: boolean
  failureLabel?: string
  run?: () => void | Promise<void>
}

interface ContextMenusLike {
  register: (contribution: {
    id: string
    target: string
    order: number
    resolve: (target: unknown) => readonly MenuActionItem[]
  }) => () => void
}

export function registerSessionContextMenu(ctx: ClientContext): () => void {
  const menus = (ctx as ClientContext & { contextMenus?: ContextMenusLike }).contextMenus
  if (menus === undefined || detectMobileDevice() || !('dshDesktop' in globalThis))
    return () => {}

  return menus.register({
    id: 'dsh-tauri.openInNewWindow',
    target: 'session',
    order: 700,
    resolve: (target) => {
      const { sessionId } = target as SessionTarget
      if (!sessionId)
        return []
      return [{
        id: 'openInNewWindow',
        label: locale.text('openInNewWindow'),
        separatorBefore: true,
        failureLabel: locale.text('openInNewWindowFailed'),
        run: () => invoke('create_app_window', { sessionId }),
      }]
    },
  })
}
