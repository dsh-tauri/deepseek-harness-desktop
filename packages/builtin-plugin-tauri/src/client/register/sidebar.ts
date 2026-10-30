import type { ClientContext } from '../types'
import { emit } from '../service/tauri'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'

const CMD_TOGGLE = 'dsh://sidebar:toggle'

const EVENT_SIDEBAR_COLLAPSED = 'dsh://sidebar:collapsed'

const SIDEBAR_FRAME_SELECTOR = '[data-shell-overlay]'
const SIDEBAR_COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'
const MOBILE_SIDEBAR_ATTRIBUTE = 'data-dsh-mobile-sidebar'

function isMobileSidebarOwned(): boolean {
  return document.documentElement.hasAttribute(MOBILE_SIDEBAR_ATTRIBUTE)
}

const SIDEBAR_TRACK_MAX_TRIES = 30
const SIDEBAR_TRACK_INTERVAL_MS = 500

function findFrame(): HTMLElement | null {
  if (typeof document === 'undefined')
    return null
  const overlay = document.querySelector<HTMLElement>(SIDEBAR_FRAME_SELECTOR)
  return overlay?.parentElement ?? null
}

function reportCollapsed(): void {
  if (isMobileSidebarOwned())
    return
  void emit(EVENT_SIDEBAR_COLLAPSED, {
    collapsed: findFrame()?.hasAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE) === true,
  })
}

export const sidebarFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.listenEvent(CMD_TOGGLE, () => {
    if (isMobileSidebarOwned())
      return
    try {
      ctx.layout.toggleSidebar()
    }
    catch (error) {
      reportPluginError(error)
    }
  })

  controller.observe(document.documentElement, reportCollapsed, {
    attributes: true,
    attributeFilter: [SIDEBAR_COLLAPSED_ATTRIBUTE, MOBILE_SIDEBAR_ATTRIBUTE],
    subtree: true,
  })

  reportCollapsed()
  let tries = 0
  const stopPoll = controller.interval(() => {
    if (findFrame() !== null) {
      reportCollapsed()
      stopPoll()
      return
    }
    if (++tries > SIDEBAR_TRACK_MAX_TRIES)
      stopPoll()
  }, SIDEBAR_TRACK_INTERVAL_MS)
})
