import type { ClientContext } from 'dsh-tauri/client'
import type { Root } from 'react-dom/client'
import { CircleTree, Icon } from 'dsh-tauri-ui/client'
import { defineRegister, findKey } from 'dsh-tauri/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  SESSION_ICON_ATTRIBUTE,
  SIDEBAR_SELECTOR,
} from '../constants'
import { store } from '../store'

const ICON_ROOTS = new WeakMap<Element, Root>()

function removeIcon(icon: Element): void {
  ICON_ROOTS.get(icon)?.unmount()
  ICON_ROOTS.delete(icon)
  icon.remove()
}

export const sessionIconsFeature = defineRegister<ClientContext>((controller) => {
  if (typeof document === 'undefined')
    return

  function reactKey(element: Element, prefix: 'session-' | ''): string | undefined {
    const fiberName = findKey(element, (_value, key) => key.startsWith('__reactFiber$'))
    let fiber = fiberName ? (element as unknown as Record<string, any>)[fiberName] : undefined
    for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
      if (typeof fiber.key === 'string' && fiber.key.startsWith(prefix))
        return fiber.key
    }
  }

  function sessionRows(): Map<string, Element> {
    const rows = new Map<string, Element>()
    for (const row of document.querySelectorAll<Element>('[role="treeitem"][aria-selected]')) {
      const id = reactKey(row, 'session-')
      if (id)
        rows.set(id, row)
    }
    return rows
  }

  function applyIcon(row: Element): void {
    if (row.querySelector(`[${SESSION_ICON_ATTRIBUTE}]`))
      return
    const actions = row.lastElementChild
    const time = actions?.previousElementSibling
    if (!actions?.querySelector('button') || !time || time.querySelector('button'))
      return

    const icon = document.createElement('span')
    icon.setAttribute(SESSION_ICON_ATTRIBUTE, '1')
    icon.style.marginRight = '5px'
    const root = createRoot(icon)
    root.render(createElement(Icon, { as: CircleTree, size: 12 }))
    ICON_ROOTS.set(icon, root)
    row.insertBefore(icon, time)
  }

  function scan(): void {
    const rows = sessionRows()
    const states = store.worktree.$state.bySession
    rows.forEach((row, sessionId) => {
      const icon = row.querySelector<HTMLElement>(`[${SESSION_ICON_ATTRIBUTE}]`)
      if (states[sessionId]?.mode === 'worktree') {
        if (!icon)
          applyIcon(row)
      }
      else if (icon) {
        removeIcon(icon)
      }
    })
  }

  controller.observe(document.body, scan, { childList: true, subtree: true })
  controller.add(store.worktree.$subscribe(scan))

  const stopPolling = controller.interval(() => {
    if (document.querySelector(SIDEBAR_SELECTOR))
      stopPolling()
  }, 400)
})
