import type { ClientContext } from 'dsh-tauri/client'
import { compact, defineRegister, uniq } from 'dsh-tauri/client'
import {
  SETTINGS_EXTERNAL_OVERLAY_SELECTORS,
  SETTINGS_UNDERLAY_SLOT_KEYS,
  SIDEBAR_WIDTH_PROPERTY,
} from '../constants'

interface ObstructionState {
  displayPriority: string
  displayValue: string
  widthPriority: string
  widthValue: string
}

interface SidebarWidthState {
  hadInlineValue: boolean
  priority: string
  value: string
}

export const registerSettingsObstructions = defineRegister<ClientContext>((controller) => {
  if (typeof document === 'undefined')
    return

  const documentRoot = document.documentElement
  const previous = new Map<HTMLElement, ObstructionState>()
  let previousSidebarWidth: SidebarWidthState | undefined

  const conceal = (): void => {
    for (const element of getObstructionTargets(document)) {
      if (!previous.has(element)) {
        previous.set(element, {
          displayPriority: element.style.getPropertyPriority('display'),
          displayValue: element.style.getPropertyValue('display'),
          widthPriority: element.style.getPropertyPriority('width'),
          widthValue: element.style.getPropertyValue('width'),
        })
      }
      element.style.setProperty('display', 'none', 'important')
      element.style.setProperty('width', '0', 'important')
    }
    documentRoot.style.setProperty(SIDEBAR_WIDTH_PROPERTY, '0', 'important')
  }

  const restore = (): void => {
    for (const [element, state] of previous) {
      restoreProperty(element.style, 'display', state.displayValue, state.displayPriority)
      restoreProperty(element.style, 'width', state.widthValue, state.widthPriority)
    }
    previous.clear()

    if (previousSidebarWidth === undefined)
      return

    if (previousSidebarWidth.hadInlineValue)
      documentRoot.style.setProperty(SIDEBAR_WIDTH_PROPERTY, previousSidebarWidth.value, previousSidebarWidth.priority)
    else
      documentRoot.style.removeProperty(SIDEBAR_WIDTH_PROPERTY)
    previousSidebarWidth = undefined
  }

  const reconcile = (): void => {
    if (controller.isDisposed())
      return

    if (document.querySelector('[data-slot-sidebar="dsh-tauri-ui"]') === null) {
      restore()
      return
    }

    if (previousSidebarWidth === undefined) {
      const value = documentRoot.style.getPropertyValue(SIDEBAR_WIDTH_PROPERTY)
      previousSidebarWidth = {
        hadInlineValue: value !== '',
        priority: documentRoot.style.getPropertyPriority(SIDEBAR_WIDTH_PROPERTY),
        value,
      }
    }
    conceal()
  }

  controller.observe(
    documentRoot,
    reconcile,
    {
      attributeFilter: ['data-dsh-better-sidebar', 'data-slot'],
      attributes: true,
      childList: true,
      subtree: true,
    },
  )
  controller.add(restore)
  reconcile()
})

function getObstructionTargets(root: ParentNode): HTMLElement[] {
  const anchors = SETTINGS_UNDERLAY_SLOT_KEYS
    .map(slotKey => root.querySelector<HTMLElement>(`[data-slot="${slotKey}"]`))
    .map(anchor => anchor?.parentElement ?? anchor)

  const overlays = SETTINGS_EXTERNAL_OVERLAY_SELECTORS
    .flatMap(selector => [...root.querySelectorAll<HTMLElement>(selector)])

  return uniq(compact([...anchors, ...overlays]))
}

function restoreProperty(style: CSSStyleDeclaration, property: string, value: string, priority: string): void {
  if (value !== '')
    style.setProperty(property, value, priority)
  else
    style.removeProperty(property)
}
