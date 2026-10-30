import type { RegisterController } from './index'
import { ARCHIVE_STREAM_PATH } from '../../shared/constants'
import { emit, invoke } from '../service/tauri'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'

const OPEN_WINDOW_ATTRIBUTE = 'data-dsh-tauri-open-window'

const FULLSCREEN_SELECTOR = '[data-sidebar-right-mode]'

const EXPAND_SELECTOR = '[data-sidebar-right-expand]'

const TOGGLE_SELECTOR = '[data-sidebar-right-toggle]'

const SESSION_SELECTOR = '[data-sidebar-right-session]'

const TAB_SELECTOR = '[data-dockkit-tab]'
const TAB_CLOSE_SELECTOR = '[data-dockkit-tab-close]'

export const FULL_SIDEBAR_ATTRIBUTE = 'data-dsh-tauri-full-sidebar'

export const PRESENTATION_FULL_SIDEBAR = 'full-sidebar'

const LAYOUT_STORAGE_PREFIX = 'dsh.sidebar-right.v1.'

const LAYOUT_ISOLATED_ATTRIBUTE = 'data-dsh-tauri-layout-isolated'

export function isolateSidebarLayout(sessionId: string): void {
  if (document.documentElement.hasAttribute(LAYOUT_ISOLATED_ATTRIBUTE))
    return
  let shared: Storage
  let own: Storage
  try {
    shared = window.localStorage
    own = window.sessionStorage
  }
  catch {
    return
  }
  document.documentElement.setAttribute(LAYOUT_ISOLATED_ATTRIBUTE, sessionId)
  const key = `${LAYOUT_STORAGE_PREFIX}${sessionId}`
  try {
    const saved = own.getItem(key) ?? shared.getItem(key)
    if (saved !== null) {
      const parsed = JSON.parse(saved) as { bySession?: Record<string, { layout?: { expanded?: boolean, mode?: string } }> }
      const layout = parsed.bySession?.[sessionId]?.layout
      if (layout !== undefined) {
        layout.expanded = true
        layout.mode = 'fullscreen'
        own.setItem(key, JSON.stringify(parsed))
      }
    }
  }
  catch (error) {
    reportPluginError(error)
  }
  const proto = Object.getPrototypeOf(own) as Storage | null
  if (proto === null || typeof proto.getItem !== 'function')
    return
  const { getItem, setItem, removeItem } = proto
  const routed = (target: string) => target.startsWith(LAYOUT_STORAGE_PREFIX)
  proto.getItem = function (target: string): string | null {
    return routed(target) ? getItem.call(own, target) : getItem.call(this, target)
  }
  proto.setItem = function (target: string, value: string): void {
    if (routed(target))
      setItem.call(own, target, value)
    else
      setItem.call(this, target, value)
  }
  proto.removeItem = function (target: string): void {
    if (routed(target))
      removeItem.call(own, target)
    else
      removeItem.call(this, target)
  }
}

const FULL_SIDEBAR_PRESENTING = 'presenting'

const FULL_SIDEBAR_READY = 'ready'

const PRESENT_POLL_MS = 250
const PRESENT_MAX_TICKS = 32

const FULL_SIDEBAR_READY_MESSAGE = 'dsh://full-sidebar:ready'

const TOOLTIP_STYLE = 'position:fixed;z-index:100;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:nowrap;pointer-events:none;display:none'

const TOOLTIP_DELAY_MS = 300
const TOOLTIP_GAP = 6

const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5H13C13.2761 2.5 13.5 2.72386 13.5 3V6.5" stroke="currentColor"/><path d="M13.1 2.9L8.5 7.5" stroke="currentColor"/><path d="M12 9.5V13C12 13.2761 11.7761 13.5 11.5 13.5H3C2.72386 13.5 2.5 13.2761 2.5 13V3C2.5 2.72386 2.72386 2.5 3 2.5H6.5" stroke="currentColor"/></svg>'

function buttonLabel(mode: Element): string {
  return /[\u4E00-\u9FA5]/.test(mode.getAttribute('aria-label') ?? '')
    ? '在新窗口全屏打开'
    : 'Open full screen in new window'
}

function openWindow(button: HTMLElement): void {
  const sessionId = button.closest(SESSION_SELECTOR)?.getAttribute('data-sidebar-right-session')
  document.querySelector<HTMLElement>(TOGGLE_SELECTOR)?.click()
  void invoke('create_app_window', {
    sessionId: sessionId ?? undefined,
    presentation: PRESENTATION_FULL_SIDEBAR,
  }).catch((error: unknown) => reportPluginError(error))
}

function isFullSidebarDocument(): boolean {
  return document.documentElement.hasAttribute(FULL_SIDEBAR_ATTRIBUTE)
}

interface Tooltip {
  attach: (anchor: HTMLElement, text: string) => void
  hide: () => void
  dispose: () => void
}

function createTooltip(): Tooltip {
  let bubble: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const hide = () => {
    clearTimeout(timer)
    if (bubble !== null)
      bubble.style.display = 'none'
  }
  const show = (anchor: HTMLElement, text: string) => {
    bubble ??= document.createElement('div')
    bubble.setAttribute('role', 'tooltip')
    bubble.style.cssText = TOOLTIP_STYLE
    bubble.textContent = text
    document.body.append(bubble)
    const rect = anchor.getBoundingClientRect()
    bubble.style.display = 'block'
    const width = bubble.getBoundingClientRect().width
    bubble.style.top = `${rect.bottom + TOOLTIP_GAP}px`
    bubble.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 4), window.innerWidth - width - 4)}px`
  }
  return {
    attach(anchor, text) {
      anchor.addEventListener('pointerenter', () => {
        clearTimeout(timer)
        timer = setTimeout(show, TOOLTIP_DELAY_MS, anchor, text)
      })
      anchor.addEventListener('pointerleave', hide)
    },
    hide,
    dispose() {
      hide()
      bubble?.remove()
      bubble = null
    },
  }
}

function conceal(element: Element | null | undefined): void {
  if (element instanceof HTMLElement)
    element.style.setProperty('display', 'none', 'important')
}

function guardLastTab(): void {
  const single = isFullSidebarDocument() && document.querySelectorAll(TAB_SELECTOR).length <= 1
  document.querySelectorAll<HTMLElement>(TAB_CLOSE_SELECTOR).forEach((close) => {
    if (single)
      close.style.setProperty('display', 'none', 'important')
    else
      close.style.removeProperty('display')
  })
}

function place(tooltip: Tooltip): void {
  const mode = document.querySelector<HTMLElement>(FULLSCREEN_SELECTOR)
  const parent = mode?.parentElement
  if (mode == null || parent == null)
    return
  let button = document.querySelector<HTMLButtonElement>(`[${OPEN_WINDOW_ATTRIBUTE}]`)
  if (button === null) {
    const created = document.createElement('button')
    created.type = 'button'
    created.setAttribute(OPEN_WINDOW_ATTRIBUTE, '')
    const label = buttonLabel(mode)
    created.setAttribute('aria-label', label)
    created.className = mode.className
    created.innerHTML = ICON
    created.addEventListener('click', () => {
      tooltip.hide()
      openWindow(created)
    })
    tooltip.attach(created, label)
    parent.insertBefore(created, mode)
    button = created
  }
  else if (mode.previousElementSibling !== button) {
    parent.insertBefore(button, mode)
  }
  if (isFullSidebarDocument()) {
    conceal(button)
    conceal(mode)
    conceal(document.querySelector(TOGGLE_SELECTOR))
  }
}

export function closeWhenArchived(controller: RegisterController, sessionId: string): void {
  if (typeof EventSource === 'undefined') {
    console.warn('[dsh-tauri] archive-watch: no EventSource')
    return
  }
  const source = new EventSource(ARCHIVE_STREAM_PATH)
  console.warn('[dsh-tauri] archive-watch: subscribe', { sessionId, url: ARCHIVE_STREAM_PATH })
  let closing = false
  controller.add(() => source.close())
  source.addEventListener('open', () => console.warn('[dsh-tauri] archive-watch: open'))
  source.addEventListener('error', () => console.warn('[dsh-tauri] archive-watch: error', { readyState: source.readyState }))
  source.addEventListener('message', (event) => {
    if (closing)
      return
    const archived = archivedSessionIds(event.data)
    if (archived?.includes(sessionId) !== true)
      return
    closing = true
    source.close()
    console.warn('[dsh-tauri] archive-watch: closing archived window', { sessionId })
    void emit('dsh://window:close')
  })
}

function archivedSessionIds(data: unknown): string[] | undefined {
  if (typeof data !== 'string')
    return undefined
  try {
    const payload = JSON.parse(data) as { archivedSessionIds?: unknown }
    return Array.isArray(payload.archivedSessionIds) ? payload.archivedSessionIds.map(String) : undefined
  }
  catch {
    return undefined
  }
}

export function presentFullSidebar(controller: RegisterController): void {
  document.documentElement.setAttribute(FULL_SIDEBAR_ATTRIBUTE, FULL_SIDEBAR_PRESENTING)
  document.body?.style.setProperty('visibility', 'hidden', 'important')
  let ticks = 0
  let expandClicked = false
  const cancel = controller.interval(() => {
    ticks += 1
    const settle = () => {
      cancel()
      document.documentElement.setAttribute(FULL_SIDEBAR_ATTRIBUTE, FULL_SIDEBAR_READY)
      document.body?.style.removeProperty('visibility')
      console.warn('[dsh-tauri] present: ready', { ticks })
      void emit(FULL_SIDEBAR_READY_MESSAGE)
    }
    if (ticks > PRESENT_MAX_TICKS) {
      settle()
      return
    }
    const mode = document.querySelector<HTMLElement>(FULLSCREEN_SELECTOR)
    if (mode == null) {
      const expand = document.querySelector<HTMLElement>(EXPAND_SELECTOR)
      if (!expandClicked && expand !== null) {
        expandClicked = true
        expand.click()
      }
      return
    }
    if (mode.getAttribute('data-sidebar-right-mode') === 'fullscreen') {
      mode.click()
      return
    }
    settle()
  }, PRESENT_POLL_MS)
}

function blockLastTabMenu(event: MouseEvent): void {
  if (!isFullSidebarDocument() || document.querySelectorAll(TAB_SELECTOR).length > 1)
    return
  const target = event.target as Element | null
  if (typeof target?.closest !== 'function' || target.closest(TAB_SELECTOR) === null)
    return
  event.preventDefault()
  event.stopPropagation()
}

export const sidebarFullwindowFeature = defineRegister((controller) => {
  const tooltip = createTooltip()
  controller.add(() => tooltip.dispose())
  const inject = () => {
    try {
      place(tooltip)
      guardLastTab()
    }
    catch (error) {
      reportPluginError(error)
    }
  }
  document.addEventListener('contextmenu', blockLastTabMenu, true)
  controller.add(() => document.removeEventListener('contextmenu', blockLastTabMenu, true))
  controller.observe(document.body, inject)
  inject()
})
