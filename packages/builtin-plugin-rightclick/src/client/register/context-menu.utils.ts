import { detectMobileDevice } from 'dsh-tauri/client'

function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
}

export function shortcutLabel(key: string): string {
  if (detectMobileDevice())
    return ''
  return isMacOS() ? `⌘${key}` : `Ctrl+${key}`
}

export function redoShortcutLabel(): string {
  if (detectMobileDevice())
    return ''
  return isMacOS() ? '⇧⌘Z' : 'Ctrl+Y'
}
