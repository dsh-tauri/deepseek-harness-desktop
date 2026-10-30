import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from 'dsh-tauri/client'
import type { MobileSettingsPresentation, MobileSettingsSnapshot, MobileSettingsView } from '../types/settings'
import type { MobileSettingsNodes } from './settings.utils'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { MobileSettingsControls } from '../components/mobile-settings-controls'
import { MOBILE_SETTINGS_MEDIA } from '../constants'
import { locale } from '../locales'
import { resolveSettingsPresentation } from '../service/settings'
import { applySettingsPresentation, createSettingsAttributePatch, findMobileSettingsPanel, isForegroundSettingsPanel } from './settings.utils'

const INACTIVE_SETTINGS: MobileSettingsSnapshot = { ready: false, view: 'detail', title: '' }

export const registerMobileSettings = defineRegister<ClientContext>((controller, ctx) => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return
  const media = window.matchMedia(MOBILE_SETTINGS_MEDIA)
  const patch = createSettingsAttributePatch()
  const abandonedPanels = new WeakSet<HTMLElement>()
  const listeners = new Set<() => void>()
  let snapshot = INACTIVE_SETTINGS
  let nodes: MobileSettingsNodes | null = null
  let view: MobileSettingsView = 'detail'
  let pendingMenu = false
  let pendingNavigation = false
  let cancelSync: (() => void) | undefined
  let cancelMenu: (() => void) | undefined
  const publish = (next: MobileSettingsSnapshot): void => {
    if (snapshot === next)
      return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const restore = (): void => {
    const previous = nodes
    const focusedOwnControls = previous?.controls.contains(document.activeElement)
    patch.restore()
    nodes = null
    publish(INACTIVE_SETTINGS)
    if (previous && focusedOwnControls && isForegroundSettingsPanel(previous.panel)) {
      const target = previous.current && !previous.current.disabled && previous.current.closest('[hidden], [inert]') === null
        ? previous.current
        : previous.close
      target.focus({ preventScroll: true })
    }
  }
  const sync = (): void => {
    if (controller.isDisposed())
      return
    const next = media.matches && document.getElementById('dsh-bridge-mobile-styles') === null
      ? findMobileSettingsPanel()
      : null
    if (!patch.isIntact() && nodes !== null) {
      abandonedPanels.add(nodes.panel)
      console.warn('[dsh-tauri-mobile-ui] Mobile settings attributes changed ownership; preserving native settings.')
      restore()
      pendingNavigation = false
      return
    }
    if (next === null || abandonedPanels.has(next.panel)) {
      restore()
      pendingNavigation = false
      return
    }
    const entering = nodes?.panel !== next.panel
    const changing = nodes?.list !== next.list || nodes?.options !== next.options || nodes?.controls !== next.controls
    const selectionChanged = nodes !== null && nodes.current !== next.current
    const resolved = resolveSettingsPresentation(snapshot, view, {
      entering,
      changing,
      launcher: pendingMenu,
      navigation: pendingNavigation,
      selectionChanged,
      title: next.current?.textContent?.trim() ?? null,
      focused: { list: next.list.contains(document.activeElement), options: next.options.contains(document.activeElement), controls: next.controls.contains(document.activeElement) },
    })
    if (entering || changing)
      patch.restore()
    if (entering) {
      pendingMenu = false
      cancelMenu?.()
      cancelMenu = undefined
    }
    view = resolved.snapshot.view
    nodes = next
    applySettingsPresentation(next, view, patch)
    publish(resolved.snapshot)
    if (resolved.focus !== null && isForegroundSettingsPanel(next.panel))
      (resolved.focus === 'back' ? next.back : next.current ?? next.title).focus({ preventScroll: true })
    pendingNavigation = false
  }
  const schedule = (): void => {
    cancelSync?.()
    cancelSync = controller.timeout(() => {
      cancelSync = undefined
      sync()
    }, 0)
  }
  const presentation: MobileSettingsPresentation = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    back: () => {
      if (nodes === null || !isForegroundSettingsPanel(nodes.panel))
        return
      view = 'menu'
      pendingNavigation = false
      sync()
    },
  }
  controller.listen('click', (event) => {
    if (event.defaultPrevented || !media.matches || !(event.target instanceof Element) || nodes !== null)
      return
    const button = event.target.closest<HTMLButtonElement>('button[aria-haspopup="dialog"]')
    if (!button || button.disabled || (button.closest('[data-slot="settings.launcher"]') === null && button.querySelector('[data-slot="settings.trigger"]') === null))
      return
    pendingMenu = true
    cancelMenu?.()
    cancelMenu = controller.timeout(() => {
      pendingMenu = false
    }, 0)
  }, { capture: true })
  controller.listen('click', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element) || nodes === null)
      return
    const button = event.target.closest('button')
    if (button?.parentElement !== nodes.list || button.disabled)
      return
    pendingNavigation = true
    schedule()
  })
  controller.listenWindow('resize', sync)
  // keep:effect MediaQueryList changes have no controller event target; controller owns their cleanup.
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', sync)
    controller.add(() => media.removeEventListener('change', sync))
  }
  else if (typeof media.addListener === 'function') {
    media.addListener(sync)
    controller.add(() => media.removeListener(sync))
  }
  else {
    console.warn('[dsh-tauri-mobile-ui] Mobile settings media subscription unavailable; preserving native settings.')
    return
  }
  controller.observe(document.documentElement, sync, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-current', 'aria-labelledby', 'role', 'aria-modal', 'data-slot', 'disabled', 'id', 'hidden', 'inert', 'data-dsh-mobile-settings', 'data-dsh-mobile-settings-view', ...['overlay', 'nav', 'title', 'list', 'content', 'header', 'actions', 'close', 'options'].map(name => `data-dsh-mobile-settings-${name}`)],
  })
  controller.add(() => {
    cancelSync?.()
    cancelMenu?.()
    restore()
    listeners.clear()
  })
  controller.add(ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: `${PLUGIN_ID}: back`,
    order: -100,
    locale: locale.NS,
    registrant: PLUGIN_ID,
    inject: () => ({ presentation }),
  }, MobileSettingsControls)))
  sync()
})
