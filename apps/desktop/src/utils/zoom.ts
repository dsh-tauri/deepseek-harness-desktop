import type { ZoomAction } from '@/store/modules/setting/types'

export interface ZoomShortcutLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export function zoomActionFromShortcut(shortcut: ZoomShortcutLike): ZoomAction | null {
  if ((!shortcut.ctrlKey && !shortcut.metaKey) || shortcut.altKey)
    return null

  if (shortcut.key === '+' || shortcut.key === '=')
    return 'increase'
  if (shortcut.key === '-' || shortcut.key === '_')
    return 'decrease'
  if (shortcut.key === '0')
    return 'reset'
  return null
}

export function zoomActionFromPayload(value: unknown): ZoomAction | null {
  const action = (value as { action?: unknown } | null | undefined)?.action
  return action === 'increase' || action === 'decrease' || action === 'reset' ? action : null
}
