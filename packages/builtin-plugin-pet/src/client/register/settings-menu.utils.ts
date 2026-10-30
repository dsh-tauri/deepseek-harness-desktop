import type { Root } from 'react-dom/client'
import { Ghost, Icon } from 'dsh-tauri-ui/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  MENU_ITEM_ICON_SELECTOR,
  MENU_ITEM_LABEL_SELECTOR,
  MENU_ITEM_SHORTCUT_SELECTOR,
  PET_MENU_ITEM_ATTRIBUTE,
  SETTINGS_MENU_LABELS,
} from '../constants'

/** 克隆条目里的图标由 React 接管（`Ghost` 随 currentColor 变色），与官方条目同一套图标组件。 */
const ICON_ROOTS = new WeakMap<HTMLElement, Root>()

function renderIcon(icon: HTMLElement): void {
  ICON_ROOTS.get(icon)?.unmount()
  const root = createRoot(icon)
  root.render(createElement(Icon, { as: Ghost }))
  ICON_ROOTS.set(icon, root)
}

/**
 * 该条目是否是设置菜单的锚点（文案为「设置」）。
 *
 * 官方账号菜单与壳层自有菜单都以它作为唯一稳定锚点：两者条目结构相同（primitives 的
 * `button[role=menuitem]`），其它菜单（工作区、模型选择）不含该文案。
 *
 * 只认 `itemLabel` 节点的文案而非按钮 `textContent`：带快捷键的条目（桌面账号菜单的
 * 「设置」由壳层传入 `settingsShortcut`）会把 `Ctrl+,` 键帽串进 `textContent`，
 * 整串比较会把唯一锚点判否，宠物项随之静默消失。
 */
export function isSettingsMenuItem(item: HTMLElement): boolean {
  const label = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)?.textContent ?? item.textContent ?? ''
  return SETTINGS_MENU_LABELS.includes(label.trim())
}

/**
 * 克隆官方条目改成桌宠动作项：样式随克隆继承（绝不手写动态类名哈希），只换文案与图标，
 * 并摘掉键帽——桌宠条目不响应 `Ctrl+,`。
 * 文案节点缺失（非 primitives 结构）时返回 null，调用方中止插入，不追加半成品条目。
 */
export function decoratePetMenuItem(source: HTMLButtonElement, label: string): HTMLButtonElement | null {
  const item = source.cloneNode(true) as HTMLButtonElement
  const labelNode = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)
  if (labelNode === null)
    return null
  labelNode.textContent = label
  const icon = item.querySelector<HTMLElement>(MENU_ITEM_ICON_SELECTOR)
  if (icon !== null)
    renderIcon(icon)
  item.querySelector<HTMLElement>(MENU_ITEM_SHORTCUT_SELECTOR)?.remove()
  item.setAttribute(PET_MENU_ITEM_ATTRIBUTE, '1')
  return item
}
