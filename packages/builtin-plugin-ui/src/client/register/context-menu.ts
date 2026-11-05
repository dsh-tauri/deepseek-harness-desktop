import type { ClientContext } from 'dsh-tauri/client'
import { detectMobileDevice, invoke } from 'dsh-tauri/client'
import { locale } from '../locales'

interface SessionTarget {
  sessionId: string
}

interface MenuActionItem {
  id: string
  label: string
  separatorBefore?: boolean
  failureLabel?: string
  run?: () => void | Promise<void>
}

interface ContextMenusLike {
  register: (contribution: {
    id: string
    target: 'session'
    order: number
    resolve: (target: SessionTarget) => readonly MenuActionItem[]
  }) => () => void
}

export function registerSessionContextMenu(ctx: ClientContext): () => void {
  const menus = ctx.get('contextMenus') as ContextMenusLike | undefined
  if (typeof menus?.register !== 'function' || detectMobileDevice() || !('dshDesktop' in globalThis))
    return () => {}

  return menus.register({
    id: 'dsh-tauri.openInNewWindow',
    target: 'session',
    order: 700,
    resolve: ({ sessionId }) => sessionId
      ? [{
          id: 'openInNewWindow',
          label: locale.text('openInNewWindow'),
          separatorBefore: true,
          failureLabel: locale.text('openInNewWindowFailed'),
          run: () => invoke('create_app_window', { sessionId }),
        }]
      : [],
  })
}
