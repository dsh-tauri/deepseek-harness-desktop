import type { ClientContext, ParentMessage } from 'dsh-tauri/client'
import type { KeyboardEvent } from 'react'
import type { SidebarGesture, SidebarGesturePoint } from '../service/sidebar-gesture'
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
import { createSidebarGesture, finishSidebarGesture, moveSidebarGesture, SIDEBAR_CLICK_SUPPRESSION_MS } from '../service/sidebar-gesture'
import { getMobileSessionId, getMobileSessionTitle } from '../service/sidebar-session'

const SHELL_OVERLAY_SLOT = 'shell.overlay'
const SIDEBAR_TOGGLE_COMMAND = 'dsh://sidebar:toggle'
const SIDEBAR_COLLAPSED_EVENT = 'dsh://sidebar:collapsed'
const SIDEBAR_BREAKPOINT = 1024
const SIDEBAR_PROPERTIES = [
  '--dsh-mobile-sidebar-width',
  '--dsh-mobile-sidebar-offset',
] as const
const LAYOUT_SELECTOR = '[data-shell-overlay], [class$="_frame"], [class$="_sidebarCol"], [class$="_centerCol"], [data-slot="main"]'

interface SidebarSnapshot {
  mobile: boolean
  open: boolean
  dragging: boolean
  offset: number
  width: number
  starting: boolean
  startFailed: boolean
}

interface ActiveGesture {
  state: SidebarGesture
  target: Element
  frame: HTMLElement
  source: 'touch' | 'pointer'
}

interface InlineProperty {
  value: string
  priority: string
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

function canStartGesture(target: EventTarget | null, frame: HTMLElement): target is Element {
  if (!(target instanceof Element) || !frame.contains(target))
    return false
  if (target.closest('input,textarea,select,[contenteditable]') !== null)
    return false
  if (target.closest('[data-dsh-mobile-sidebar-toggle], [data-dsh-mobile-new-session]') !== null)
    return false
  if (target.closest('[data-shell-overlay]') !== null && target.closest('[data-dsh-mobile-sidebar-shade]') === null)
    return false
  if (window.getSelection()?.isCollapsed === false)
    return false
  let current: Element | null = target
  while (current !== null && current !== frame) {
    const style = getComputedStyle(current)
    if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && current.scrollWidth > current.clientWidth + 1)
      return false
    current = current.parentElement
  }
  return true
}

function eventTime(event: Event): number {
  return event.timeStamp || performance.now()
}

function touchPoint(touch: Touch, event: TouchEvent): SidebarGesturePoint {
  return { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: eventTime(event) }
}

function pointerPoint(event: PointerEvent): SidebarGesturePoint {
  return { id: event.pointerId, x: event.clientX, y: event.clientY, time: eventTime(event) }
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
  const previousProperties = new Map<string, InlineProperty>(SIDEBAR_PROPERTIES.map(name => [name, {
    value: root.style.getPropertyValue(name),
    priority: root.style.getPropertyPriority(name),
  }]))
  const navbarHost = document.createElement('div')
  navbarHost.setAttribute('data-dsh-mobile-navbar-host', '')
  let navbar: HTMLElement | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => listeners.forEach(listener => listener())
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  let snapshot: SidebarSnapshot = {
    mobile: canOwnMobileSidebar(),
    open: false,
    dragging: false,
    offset: 0,
    width: getSidebarWidth(),
    starting: false,
    startFailed: false,
  }
  const getSnapshot = (): SidebarSnapshot => snapshot
  const getNavbarHost = (): HTMLElement | null => navbarHost.isConnected ? navbarHost : null
  const sessionSource = adapter.sessions.list
  const getSessionSnapshot = (): unknown => sessionSource?.getSnapshot()
  let selectedSession = getMobileSessionId(getSessionSnapshot())
  let gesture: ActiveGesture | null = null
  let suppressClickUntil = 0
  let suppressedClickTarget: Element | null = null
  let suppressedClickFrame: HTMLElement | null = null
  const accessibility = new Map<HTMLElement, { ariaHidden: string | null, inert: boolean }>()
  let focusRestoreTarget: HTMLElement | SVGElement | null = null
  let focusedDrawer: { element: HTMLElement, tabIndex: string | null } | null = null
  let focusDrawerOnOpen = false

  const clearGesture = (): void => {
    const current = gesture
    // Flush the last drag position before restoring CSS transitions, including same-frame releases.
    if (current !== null && snapshot.dragging)
      current.frame.querySelector('[class$="_centerCol"]')?.getBoundingClientRect()
    gesture = null
    if (current?.source === 'pointer' && current.state.axis === 'x'
      && typeof current.frame.hasPointerCapture === 'function'
      && current.frame.hasPointerCapture(current.state.id)) {
      current.frame.releasePointerCapture(current.state.id)
    }
  }
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
    if (gesture !== null && (frame !== gesture.frame || !gesture.target.isConnected || !frame?.contains(gesture.target)))
      resetGesture()
    const center = snapshot.mobile ? frame?.querySelector<HTMLElement>('[class$="_centerCol"]') : null
    if (center) {
      if (navbar !== null && navbar.parentNode === null && !navbarHost.hasChildNodes())
        navbarHost.append(navbar)
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
  const restoreProperties = (): void => {
    previousProperties.forEach((property, name) => {
      if (property.value !== '')
        root.style.setProperty(name, property.value, property.priority)
      else
        root.style.removeProperty(name)
    })
  }
  const syncDom = (): void => {
    root.toggleAttribute('data-dsh-mobile-sidebar', snapshot.mobile)
    root.toggleAttribute('data-dsh-mobile-sidebar-open', snapshot.mobile && snapshot.open)
    root.toggleAttribute('data-dsh-mobile-sidebar-dragging', snapshot.mobile && snapshot.dragging)
    if (snapshot.mobile) {
      root.style.setProperty(SIDEBAR_PROPERTIES[0], `${snapshot.width}px`)
      if (snapshot.dragging)
        root.style.setProperty(SIDEBAR_PROPERTIES[1], `${snapshot.offset}px`)
      else
        root.style.removeProperty(SIDEBAR_PROPERTIES[1])
    }
    else {
      restoreProperties()
    }
    reconcileFrame()
  }
  const publish = (next: SidebarSnapshot): void => {
    if (
      next.mobile === snapshot.mobile && next.open === snapshot.open
      && next.dragging === snapshot.dragging && next.offset === snapshot.offset
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
    clearGesture()
    if (open && !wasOpen) {
      focusDrawerOnOpen = true
      const active = document.activeElement
      focusRestoreTarget = (active instanceof HTMLElement || active instanceof SVGElement)
        && active !== document.body && !active.closest('[data-dsh-mobile-sidebar-shade]')
        ? active
        : null
    }
    publish({ ...snapshot, open, dragging: false, offset: open ? snapshot.width : 0 })
    if (!open && wasOpen)
      restoreFocusTarget()
    if (changed)
      safeReportCollapsed(!open)
  }
  // keep:function `reconcileFrame` 属于 publish → syncDom → reconcileFrame 环，声明式函数才能在环内前向引用。
  function resetGesture(): void {
    clearGesture()
    publish({ ...snapshot, dragging: false, offset: snapshot.open ? snapshot.width : 0 })
  }
  const syncMobile = (): void => {
    const mobile = canOwnMobileSidebar()
    const width = getSidebarWidth()
    const wasMobile = snapshot.mobile
    if (!mobile) {
      clearGesture()
      suppressedClickTarget = null
      suppressedClickFrame = null
      suppressClickUntil = 0
      publish({ ...snapshot, mobile: false, open: false, dragging: false, offset: 0, width, startFailed: false })
      if (wasMobile) {
        restoreFocusTarget()
        controller.timeout(() => safeReportCollapsed(getFrame()?.hasAttribute('data-sidebar-collapsed') === true), 0)
      }
      return
    }
    if (width !== snapshot.width)
      clearGesture()
    publish({
      ...snapshot,
      mobile: true,
      width,
      dragging: gesture !== null && snapshot.dragging,
      offset: gesture !== null && snapshot.dragging ? Math.min(width, snapshot.offset) : snapshot.open ? width : 0,
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
  controller.listen('click', (event) => {
    const target = event.target
    if (performance.now() >= suppressClickUntil || suppressedClickTarget === null || !(target instanceof Element))
      return
    const frame = suppressedClickFrame
    const retargeted = frame?.contains(target) && (target.closest('[data-dsh-mobile-sidebar-shade]') !== null
      || target === frame || target === frame.querySelector('[class$="_centerCol"]'))
    if (!suppressedClickTarget.contains(target) && !retargeted)
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    suppressClickUntil = 0
    suppressedClickTarget = null
    suppressedClickFrame = null
  }, { capture: true })

  const beginGesture = (point: SidebarGesturePoint, target: EventTarget | null, source: ActiveGesture['source']): void => {
    const frame = getFrame()
    if (!snapshot.mobile || gesture !== null || frame === null || !canStartGesture(target, frame))
      return
    suppressedClickTarget = null
    suppressedClickFrame = null
    suppressClickUntil = 0
    gesture = { state: createSidebarGesture(point, snapshot.open, snapshot.width), target, frame, source }
  }
  const moveGesture = (point: SidebarGesturePoint, event: TouchEvent | PointerEvent, source: ActiveGesture['source']): void => {
    if (gesture === null || gesture.source !== source || gesture.state.id !== point.id)
      return
    const result = moveSidebarGesture(gesture.state, point, snapshot.width, event.cancelable)
    if (result.gesture === null) {
      resetGesture()
      return
    }
    const claimed = gesture.state.axis === null && result.gesture.axis === 'x'
    gesture.state = result.gesture
    if (result.offset === undefined)
      return
    if (claimed && source === 'pointer' && typeof gesture.frame.setPointerCapture === 'function')
      gesture.frame.setPointerCapture(point.id)
    event.preventDefault()
    publish({ ...snapshot, dragging: true, offset: result.offset })
  }
  const endGesture = (point: SidebarGesturePoint | undefined, cancelled: boolean, source: ActiveGesture['source']): void => {
    if (gesture === null || gesture.source !== source || (point !== undefined && gesture.state.id !== point.id))
      return
    const current = gesture
    const result = cancelled ? null : finishSidebarGesture(current.state, point, snapshot.width)
    clearGesture()
    if (result === null) {
      resetGesture()
      return
    }
    setOpen(result.open)
    suppressedClickTarget = result.suppressClick ? current.target : null
    suppressedClickFrame = result.suppressClick ? current.frame : null
    suppressClickUntil = result.suppressClick ? performance.now() + SIDEBAR_CLICK_SUPPRESSION_MS : 0
  }
  controller.listen('touchstart', (event) => {
    if (event.touches.length !== 1) {
      if (gesture?.source === 'touch')
        resetGesture()
      return
    }
    if (!event.defaultPrevented)
      beginGesture(touchPoint(event.touches[0], event), event.target, 'touch')
  }, { passive: true })
  controller.listen('touchmove', (event) => {
    if (gesture?.source !== 'touch')
      return
    if (event.touches.length !== 1) {
      resetGesture()
      return
    }
    const touch = [...event.touches].find(point => point.identifier === gesture?.state.id)
    if (touch)
      moveGesture(touchPoint(touch, event), event, 'touch')
  }, { passive: false })
  const endTouch = (event: TouchEvent, cancelled: boolean): void => {
    const touch = [...event.changedTouches].find(point => point.identifier === gesture?.state.id)
    if (touch || cancelled)
      endGesture(touch ? touchPoint(touch, event) : undefined, cancelled, 'touch')
  }
  controller.listen('touchend', event => endTouch(event, false))
  controller.listen('touchcancel', event => endTouch(event, true))
  controller.listen('pointerdown', (event) => {
    if (event.pointerType !== 'touch' && event.button === 0 && event.isPrimary !== false && !event.defaultPrevented)
      beginGesture(pointerPoint(event), event.target, 'pointer')
  })
  controller.listen('pointermove', (event) => {
    if (event.pointerType === 'touch')
      return
    if (gesture?.source === 'pointer' && event.buttons === 0) {
      resetGesture()
      return
    }
    moveGesture(pointerPoint(event), event, 'pointer')
  }, { passive: false })
  controller.listen('pointerup', (event) => {
    if (event.pointerType !== 'touch')
      endGesture(pointerPoint(event), false, 'pointer')
  })
  controller.listen('pointercancel', (event) => {
    if (event.pointerType !== 'touch')
      endGesture(pointerPoint(event), true, 'pointer')
  })
  controller.listen('lostpointercapture', (event) => {
    if (gesture?.source === 'pointer' && gesture.state.id === event.pointerId)
      resetGesture()
  })
  controller.listenWindow('blur', () => resetGesture())

  const resize = (): void => {
    resetGesture()
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
      if (record.target === navbarHost || (record.target instanceof Element && record.target.matches('[class$="_frame"], [class$="_centerCol"]')))
        return true
      if (focusedDrawer !== null && !focusedDrawer.element.isConnected)
        return true
      if (gesture !== null && (!gesture.target.isConnected || !gesture.frame.isConnected))
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
    if (navbar !== null && navbar.parentNode === null && !navbarHost.hasChildNodes())
      navbarHost.append(navbar)
    listeners.clear()
    clearGesture()
    suppressedClickTarget = null
    suppressedClickFrame = null
    suppressClickUntil = 0
    snapshot = { ...snapshot, mobile: false, open: false, dragging: false, offset: 0 }
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
            <nav ref={(element) => { navbar = element }} data-dsh-mobile-topbar aria-label={locale.text('navbar.label')}>
              <Icon
                as={LayoutSideContentLeft}
                size={12}
                data-dsh-mobile-sidebar-toggle
                role="button"
                tabIndex={0}
                focusable="true"
                onPointerDown={event => event.currentTarget.blur()}
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
                onPointerDown={event => event.currentTarget.blur()}
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
          <div data-dsh-mobile-sidebar-overlay data-dsh-mobile-sidebar-dragging={current.dragging || undefined}>
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
