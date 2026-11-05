import type { OfficialSelectOptions } from './context-menu.types'
import { find } from 'dsh-tauri/client'
import { ACTION_BUTTON_SELECTOR, MENU_ITEM_SELECTOR } from '../constants'
import { locale } from '../locales'
import { isWorkspaceAction, officialAction } from './locate'

/**
 * 官方菜单项选择：点击行内操作按钮后在 [role=menuitem] 中按文案点目标项。
 * 调度与失败回报都交回调用方（副作用经 controller 托管）。
 */
export async function officialSelect(
  row: Element,
  labels: RegExp[],
  failureMessage: string,
  options: OfficialSelectOptions,
): Promise<void> {
  const findAction = (): HTMLButtonElement | null =>
    options.workspace
      ? find(row.querySelectorAll<HTMLButtonElement>(ACTION_BUTTON_SELECTOR), isWorkspaceAction) ?? null
      : officialAction(row)
  let action = findAction()
  if (!action && !options.workspace) {
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }))
    // keep:effect 官方操作按钮由 React 在 hover 后渲染，必须等两帧再取（一次性等待，非生命周期资源）
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    action = findAction()
  }
  if (!action)
    throw new Error(locale.text(options.workspace ? 'officialWorkspaceActionUnavailable' : 'officialSessionActionUnavailable'))
  action.click()
  options.schedule(() => {
    const item = find(document.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR), node =>
      labels.some(label => label.test(node.textContent?.trim() || '')))
    if (!item) {
      options.onFailure(failureMessage)
      return
    }
    item.click()
  }, 0)
}
