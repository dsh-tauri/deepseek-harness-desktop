import type { ClientContext, ParentMessage } from 'dsh-tauri/client'
import type { KeyboardEvent } from 'react'
import { CirclePlus, Icon, LayoutSideContentLeft } from 'dsh-tauri-ui/client'
import {
  defineRegister,
  detectMobileDevice,
  invokeParent,
  listenParent,
  MOBILE_MEDIA_QUERIES,
} from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { PLUGIN_ID } from '../../shared/constants'
import { locale } from '../locales'
import { getMobileSessionId, getMobileSessionTitle } from '../service/sidebar-session'

const SHELL_OVERLAY_SLOT = 'shell.overlay'
const SIDEBAR_TOGGLE_COMMAND = 'dsh://sidebar:toggle'
const SIDEBAR_COLLAPSED_EVENT = 'dsh://sidebar:collapsed'
const SIDEBAR_BREAKPOINT = 1024
const SIDEBAR_WIDTH_PROPERTY = '--dsh-mobile-sidebar-width'
const LAYOUT_SELECTOR = '[data-shell-overlay], [class$="_frame"], [class$="_sidebarCol"], [class$="_centerCol"], [data-slot="main"]'

interface SidebarSnapshot {
  mobile: boolean
  open: boolean
  width: number
  starting: boolean
  startFailed: boolean
}

function getSidebarWidth(): number {
  return Math.min(320, Math.max(1, Math.floor(window.innerWidth * 0.82)))
}

function getFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-shell-overlay]')?.parentElement ?? null
}

function canOwnMobileSidebar(): boolean {
  const frame = getFrame()
  return detectMobileDevice() && window.innerWidth < SIDEBAR_BREAKPOINT
    && (frame === null || frame.hasAttribute('data-rightbar-collapsed'))
}

function activateIcon(event: KeyboardEvent<SVGSVGElement>, activate: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ')
    return
  event.preventDefault()
  if (!event.repeat)
    activate()
}

function safeReportCollapsed(collapsed: boolean): void {
  try {
    invokeParent({ type: SIDEBAR_COLLAPSED_EVENT, collapsed })
  }
  catch { }
}

export const registerMobileSidebar = defineRegister<ClientContext>((controller, ctx, adapter) => {
  if (typeof document === 'undefined' || typeof window === 'undefined')
    return

  const root = document.documentElement
  const previousWidth = root.style.getPropertyValue(SIDEBAR_WIDTH_PROPERTY)
  const previousWidthPriority = root.style.getPropertyPriority(SIDEBAR_WIDTH_PROPERTY)
  const navbarHost = document.createElement('div')
  navbarHost.setAttribute('data-dsh-mobile-navbar-host', '')
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach(listener => listener())
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  let snapshot: SidebarSnapshot = {
    mobile: canOwnMobileSidebar(),
    open: false,
    width: getSidebarWidth(),
    starting: false,
    startFailed: false,
  }
  const getSnapshot = (): SidebarSnapshot => snapshot
  const getNavbarHost = (): HTMLElement | null => navbarHost.isConnected ? navbarHost : null
  const sessionSource = adapter.sessions.list
  const getSessionSnapshot = (): unknown => sessionSource?.getSnapshot()
  let selectedSession = getMobileSessionId(getSessionSnapshot())
  const accessibility = new Map<HTMLElement, { ariaHidden: string | null, inert: boolean }>()
  let focusRestoreTarget: HTMLElement | SVGElement | null = null
  let focusedDrawer: { element: HTMLElement, tabIndex: string | null } | null = null
  let focusDrawerOnOpen = false

  const restoreFocusedDrawer = (): void => {
    if (focusedDrawer === null)
      return
    if (focusedDrawer.tabIndex === null)
      focusedDrawer.element.removeAttribute('tabindex')
    else
      focusedDrawer.element.setAttribute('tabindex', focusedDrawer.tabIndex)
    focusedDrawer = null
  }
  const restoreFocusTarget = (): void => {
    const target = focusRestoreTarget
    focusRestoreTarget = null
    focusDrawerOnOpen = false
    restoreFocusedDrawer()
    if (target?.isConnected)
      target.focus({ preventScroll: true })
  }
  const syncAccessibility = (): void => {
    const frame = getFrame()
    const sidebar = frame?.querySelector<HTMLElement>('[class$="_sidebarCol"]')
    const main = frame?.querySelector<HTMLElement>('[class$="_centerCol"] > [data-slot="main"]')
    const targets = new Map<HTMLElement, boolean>()
    if (snapshot.mobile && sidebar)
      targets.set(sidebar, !snapshot.open)
    if (snapshot.mobile && main)
      targets.set(main, snapshot.open)
    for (const [element, state] of accessibility) {
      if (targets.get(element) === true)
        continue
      if (state.ariaHidden === null)
        element.removeAttribute('aria-hidden')
      else
        element.setAttribute('aria-hidden', state.ariaHidden)
      element.inert = state.inert
      accessibility.delete(element)
    }
    for (const [element, inert] of targets) {
      if (!inert)
        continue
      if (!accessibility.has(element)) {
        accessibility.set(element, {
          ariaHidden: element.getAttribute('aria-hidden'),
          inert: element.inert,
        })
      }
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    }
    if (snapshot.mobile && snapshot.open && focusedDrawer !== null && !focusedDrawer.element.isConnected)
      focusDrawerOnOpen = true
    if (snapshot.mobile && snapshot.open && focusDrawerOnOpen) {
      const drawer = sidebar?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? sidebar
      if (drawer) {
        if (focusedDrawer?.element !== drawer) {
          restoreFocusedDrawer()
          focusedDrawer = { element: drawer, tabIndex: drawer.getAttribute('tabindex') }
          if (!drawer.matches('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            drawer.tabIndex = -1
        }
        drawer.focus({ preventScroll: true })
        focusDrawerOnOpen = false
      }
    }
  }
  const reconcileFrame = (): void => {
    const previousHost = getNavbarHost()
    const frame = getFrame()
    const center = snapshot.mobile ? frame?.querySelector<HTMLElement>('[class$="_centerCol"]') : null
    if (center) {
      if (center.firstElementChild !== navbarHost)
        center.prepend(navbarHost)
    }
    else {
      navbarHost.remove()
    }
    syncAccessibility()
    if (previousHost !== getNavbarHost())
      notify()
  }
  const syncDom = (): void => {
    root.toggleAttribute('data-dsh-mobile-sidebar', snapshot.mobile)
    root.toggleAttribute('data-dsh-mobile-sidebar-open', snapshot.mobile && snapshot.open)
    if (snapshot.mobile)
      root.style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${snapshot.width}px`)
    else if (previousWidth !== '')
      root.style.setProperty(SIDEBAR_WIDTH_PROPERTY, previousWidth, previousWidthPriority)
    else
      root.style.removeProperty(SIDEBAR_WIDTH_PROPERTY)
    reconcileFrame()
  }
  const publish = (next: SidebarSnapshot): void => {
    if (
      next.mobile === snapshot.mobile && next.open === snapshot.open
      && next.width === snapshot.width && next.starting === snapshot.starting
      && next.startFailed === snapshot.startFailed
    ) {
      return
    }
    snapshot = next
    syncDom()
    notify()
  }
  const setOpen = (open: boolean): void => {
    if (!snapshot.mobile || controller.isDisposed())
      return
    const wasOpen = snapshot.open
    const changed = open !== wasOpen
    if (open && !wasOpen) {
      focusDrawerOnOpen = true
      const active = document.activeElement
      focusRestoreTarget = (active instanceof HTMLElement || active instanceof SVGElement)
        && active !== document.body && !active.closest('[data-dsh-mobile-sidebar-shade]')
        ? active
        : null
    }
    publish({ ...snapshot, open })
    if (!open && wasOpen)
      restoreFocusTarget()
    if (changed)
      safeReportCollapsed(!open)
  }
  const syncMobile = (): void => {
    const mobile = canOwnMobileSidebar()
    const width = getSidebarWidth()
    const wasMobile = snapshot.mobile
    if (!mobile) {
      publish({ ...snapshot, mobile: false, open: false, width, startFailed: false })
      if (wasMobile) {
        restoreFocusTarget()
        controller.timeout(() => safeReportCollapsed(getFrame()?.hasAttribute('data-sidebar-collapsed') === true), 0)
      }
      return
    }
    publish({
      ...snapshot,
      mobile: true,
      width,
    })
    if (!wasMobile)
      safeReportCollapsed(!snapshot.open)
  }
  const toggle = (): void => setOpen(!snapshot.open)
  const startSession = async (): Promise<void> => {
    if (!snapshot.mobile || snapshot.starting || controller.isDisposed())
      return
    publish({ ...snapshot, starting: true, startFailed: false })
    try {
      const outcome = await adapter.startSession()
      if (controller.isDisposed())
        return
      if (outcome.status === 'unavailable') {
        publish({ ...snapshot, starting: false, startFailed: true })
        return
      }
      // Native startSession may return void before navigation finishes; its owner reveals the session.
      if (snapshot.mobile)
        setOpen(false)
      publish({ ...snapshot, starting: false })
    }
    catch {
      if (!controller.isDisposed())
        publish({ ...snapshot, starting: false, startFailed: true })
    }
  }

  syncDom()
  if (snapshot.mobile)
    safeReportCollapsed(!snapshot.open)
  if (sessionSource) {
    controller.add(sessionSource.subscribe(() => {
      const selected = getMobileSessionId(getSessionSnapshot())
      if (selected !== selectedSession && snapshot.open)
        setOpen(false)
      selectedSession = selected
      notify()
    }))
  }
  controller.add(listenParent<ParentMessage>(() => toggle(), SIDEBAR_TOGGLE_COMMAND))
  controller.listen('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && snapshot.mobile && snapshot.open)
      setOpen(false)
  })
  const resize = (): void => {
    syncMobile()
    reconcileFrame()
  }
  controller.listenWindow('resize', resize)
  if (typeof window.matchMedia === 'function') {
    MOBILE_MEDIA_QUERIES.forEach((query) => {
      const media = window.matchMedia(query)
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', resize)
        controller.add(() => media.removeEventListener('change', resize))
      }
      else if (typeof media.addListener === 'function') {
        media.addListener(resize)
        controller.add(() => media.removeListener(resize))
      }
    })
  }
  controller.observe(root, (records) => {
    const layoutChanged = records.some((record) => {
      if (record.type === 'attributes')
        return record.target instanceof Element && record.target.matches(`${LAYOUT_SELECTOR}, [data-sidebar-collapsed], [data-dsh-mobile-sidebar]`)
      if (record.target instanceof Element && record.target.matches('[class$="_frame"], [class$="_centerCol"]'))
        return true
      if (focusedDrawer !== null && !focusedDrawer.element.isConnected)
        return true
      return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
        && (node.matches(LAYOUT_SELECTOR) || node.querySelector(LAYOUT_SELECTOR) !== null))
    })
    if (layoutChanged) {
      syncMobile()
      reconcileFrame()
    }
  }, {
    attributes: true,
    attributeFilter: ['class', 'data-shell-overlay', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-dsh-mobile-sidebar'],
    childList: true,
    subtree: true,
  })
  controller.add(() => {
    listeners.clear()
    snapshot = { ...snapshot, mobile: false, open: false }
    syncDom()
    restoreFocusTarget()
    safeReportCollapsed(getFrame()?.hasAttribute('data-sidebar-collapsed') === true)
  })

  controller.add(ctx.slots.inject(SHELL_OVERLAY_SLOT, () => ctx.slots.register(
    {
      name: SHELL_OVERLAY_SLOT,
      id: `${PLUGIN_ID}-mobile-sidebar-overlay`,
      order: 20,
      locale: locale.NS,
      registrant: PLUGIN_ID,
    },
    () => {
      locale.useLocale()
      const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const host = useSyncExternalStore(subscribe, getNavbarHost, () => null)
      const sessions = useSyncExternalStore(subscribe, getSessionSnapshot, getSessionSnapshot)
      if (!current.mobile)
        return null
      const title = getMobileSessionTitle(sessions) ?? locale.text('session.new')
      return (
        <>
          {host && createPortal(
            <nav data-dsh-mobile-topbar aria-label={locale.text('navbar.label')}>
              <Icon
                as={LayoutSideContentLeft}
                size={12}
                data-dsh-mobile-sidebar-toggle
                role="button"
                tabIndex={0}
                focusable="true"
                aria-label={locale.text(current.open ? 'toggle.close' : 'toggle.open')}
                aria-expanded={current.open}
                onClick={toggle}
                onKeyDown={event => activateIcon(event, toggle)}
              />
              <span data-dsh-mobile-navbar-title title={title}>{title}</span>
              <Icon
                as={CirclePlus}
                size={24}
                data-dsh-mobile-new-session
                role="button"
                tabIndex={0}
                focusable="true"
                aria-label={locale.text('session.new')}
                aria-disabled={current.starting}
                aria-busy={current.starting}
                onClick={() => { void startSession() }}
                onKeyDown={event => activateIcon(event, () => { void startSession() })}
              />
              {current.startFailed && <span data-dsh-mobile-navbar-status role="status">{locale.text('session.failed')}</span>}
            </nav>,
            host,
          )}
          <div data-dsh-mobile-sidebar-overlay>
            <button
              type="button"
              data-dsh-mobile-sidebar-shade
              aria-label={locale.text('shade.close')}
              aria-hidden={!current.open}
              tabIndex={current.open ? 0 : -1}
              onClick={() => setOpen(false)}
            />
          </div>
        </>
      )
    },
  )))
})
