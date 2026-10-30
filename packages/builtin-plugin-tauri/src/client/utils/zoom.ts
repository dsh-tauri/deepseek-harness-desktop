export type ZoomAction = 'increase' | 'decrease' | 'reset'

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
