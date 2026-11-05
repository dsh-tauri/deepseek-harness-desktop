import { detectMobileDevice } from 'dsh-tauri/client'

/** 快捷键修饰键，按平台固定顺序展开。 */
export type ShortcutModifier = 'alt' | 'shift' | 'primary'

/** 官方 Menu 的快捷键描述：键帽 token 与 ARIA 组合。 */
export interface ShortcutHint {
  keys: readonly string[]
  aria?: string
}

const MAC_ORDER: readonly ShortcutModifier[] = ['alt', 'shift', 'primary']
const WIN_ORDER: readonly ShortcutModifier[] = ['primary', 'alt', 'shift']
const MAC_SYMBOL: Record<ShortcutModifier, string> = { alt: '⌥', shift: '⇧', primary: '⌘' }
const WIN_LABEL: Record<ShortcutModifier, string> = { primary: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const ARIA_NAME: Record<string, string> = { '⌘': 'Meta', '⌥': 'Alt', '⇧': 'Shift', 'Ctrl': 'Control' }

function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
}

/**
 * 键帽 token：mac 用符号连排，Windows 以 `+` 作独立 token（与官方 `ShortcutKeys` 一致）。
 * @param key - 非修饰键的显示名。
 * @param modifiers - 逻辑修饰键。
 * @returns 键帽 token；移动端没有快捷键，返回空数组。
 */
export function shortcutKeys(key: string, modifiers: readonly ShortcutModifier[] = ['primary']): readonly string[] {
  if (detectMobileDevice())
    return []
  if (isMacOS())
    return [...MAC_ORDER.filter(item => modifiers.includes(item)).map(item => MAC_SYMBOL[item]), key]
  return [...WIN_ORDER.filter(item => modifiers.includes(item)).flatMap(item => [WIN_LABEL[item], '+']), key]
}

/**
 * 菜单项快捷键：移动端不提示。
 * @param key - 非修饰键的显示名。
 * @param modifiers - 逻辑修饰键。
 * @returns 官方 `MenuItem.shortcut`；移动端为 undefined。
 */
export function shortcutHint(key: string, modifiers?: readonly ShortcutModifier[]): ShortcutHint | undefined {
  return toHint(shortcutKeys(key, modifiers))
}

/**
 * 重做快捷键：mac 为 ⇧⌘Z，Windows 为 Ctrl+Y。
 * @returns 官方 `MenuItem.shortcut`；移动端为 undefined。
 */
export function redoShortcutHint(): ShortcutHint | undefined {
  return toHint(isMacOS() ? shortcutKeys('Z', ['shift', 'primary']) : shortcutKeys('Y'))
}

/**
 * 快捷键的可读单串，只进提示文案，不进菜单。
 * @param key - 非修饰键的显示名。
 * @returns 形如 `⌘Z` 或 `Ctrl+Z` 的文本。
 */
export function shortcutLabel(key: string): string {
  return shortcutKeys(key).join('')
}

/**
 * 重做的可读单串，只进提示文案。
 * @returns 形如 `⇧⌘Z` 或 `Ctrl+Y` 的文本。
 */
export function redoShortcutLabel(): string {
  return (isMacOS() ? shortcutKeys('Z', ['shift', 'primary']) : shortcutKeys('Y')).join('')
}

function toHint(keys: readonly string[]): ShortcutHint | undefined {
  if (keys.length === 0)
    return undefined
  const aria = keys.filter(key => key !== '+').map(key => ARIA_NAME[key] ?? key).join('+')
  return { keys, aria }
}
