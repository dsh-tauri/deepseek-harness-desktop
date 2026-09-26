import { defineRegister } from 'dsh-tauri/client'
import {
  MENU_ITEM_SELECTOR,
  PET_MENU_ITEM_ATTRIBUTE,
  PET_MENU_PATCH_ATTRIBUTE,
} from '../constants'
import { locale } from '../locales'
import { loadPetStatus, togglePet } from '../service/pet'
import { store } from '../store'
import { decoratePetMenuItem, isSettingsMenuItem } from './settings-menu.utils'

/**
 * 设置菜单里的桌宠开关。
 *
 * 桌面载体下「设置」入口由官方账号菜单占据（`settings.launcher`），浏览器直开时由壳层
 * 自有菜单占据——两者都是官方 primitives 的 portal `Menu`，因此统一按「含『设置』条目」
 * 识别菜单，克隆该条目改成当前可用的桌宠动作（启用 / 关闭），点击后切换并收起菜单。
 * 官方菜单条目是 React 管理的节点，克隆项不在其 fiber 里，交互只能走本模块的原生监听。
 */
export const settingsMenuFeature = defineRegister((controller) => {
  if (typeof document === 'undefined')
    return

  void loadPetStatus()

  function patchMenu(settingsItem: HTMLButtonElement): void {
    const menu = settingsItem.closest<HTMLElement>('[role="menu"]')
    if (menu === null || menu.hasAttribute(PET_MENU_PATCH_ATTRIBUTE))
      return
    // 是否真的是官方条目由 `decoratePetMenuItem` 判定（它要求存在 `itemLabel` 文案节点）；
    // 这里不再额外要求 `itemWrap` 祖先——官方菜单的包裹结构随核心版本变过，多一道结构断言
    // 会让整条注入在结构不匹配时静默失效，而这正是「菜单里没有宠物项」的成因。
    const item = decoratePetMenuItem(settingsItem, enabled() ? locale.text('closePet') : locale.text('enablePet'))
    if (item === null)
      return
    menu.setAttribute(PET_MENU_PATCH_ATTRIBUTE, '1')
    settingsItem.after(item)
  }

  function scan(): void {
    for (const item of document.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)) {
      if (isSettingsMenuItem(item))
        patchMenu(item)
    }
  }

  controller.observe(document.body, scan, { childList: true, subtree: true })
  controller.listen('click', (event) => {
    const origin = event.target
    if (!(origin instanceof Element))
      return
    if (origin.closest(`[${PET_MENU_ITEM_ATTRIBUTE}]`) === null)
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    void togglePet({ enabled: !enabled() })
    // 克隆条目不会触发官方 onSelect（菜单不自关），派发一次外部 pointerdown 收起菜单。
    const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    document.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true }))
  }, { capture: true })
})

// --- internal ---

/** 当前是否启用（菜单条目文案与点击切换共用的唯一真值）。 */
function enabled(): boolean {
  return store.pet.$state.status?.enabled ?? false
}
