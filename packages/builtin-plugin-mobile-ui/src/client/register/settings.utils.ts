import type { MobileSettingsView } from '../types/settings'

export interface MobileSettingsNodes {
  panel: HTMLElement
  overlay: HTMLElement
  nav: HTMLElement
  title: HTMLElement
  list: HTMLElement
  content: HTMLElement
  header: HTMLElement
  actions: HTMLElement
  close: HTMLButtonElement
  options: HTMLElement
  controls: HTMLElement
  back: HTMLButtonElement
  current: HTMLButtonElement | null
}

const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'

function only(elements: Element[]): HTMLElement | null {
  return elements.length === 1 && elements[0] instanceof HTMLElement ? elements[0] : null
}

export function resolveMobileSettingsPanel(panel: HTMLElement): MobileSettingsNodes | null {
  if (!panel.isConnected || !panel.matches(DIALOG_SELECTOR) || panel.closest('[hidden], [inert]') !== null)
    return null
  const owned = (selector: string): Element[] => [...panel.querySelectorAll(selector)]
    .filter(element => element.closest(DIALOG_SELECTOR) === panel)
  const actionSlot = only(owned('[data-slot="settings.action"]'))
  const headerSlot = only(owned('[data-slot="settings.header"]'))
  const closeSlot = only(owned('[data-slot="settings.close"]'))
  const controls = only(owned('[data-dsh-mobile-settings-controls]'))
  const actions = actionSlot?.parentElement
  const header = actions?.parentElement
  const content = header?.parentElement
  const close = closeSlot?.closest('button')
  const titleId = panel.getAttribute('aria-labelledby')?.trim()
  const title = titleId && !/\s/.test(titleId)
    ? only([...document.querySelectorAll('[id]')].filter(element => element.id === titleId))
    : null
  const nav = title?.parentElement
  const list = nav && only([...nav.children].filter(element => element !== title))
  const options = content && only([...content.children].filter(element => element !== header))
  const back = controls && only([...controls.querySelectorAll('[data-dsh-mobile-settings-back]')]
    .filter(element => element.closest(DIALOG_SELECTOR) === panel))
  const overlay = panel.parentElement
  if (!actions || !header || !content || !nav || !title || !list || !options || !overlay
    || !controls || !(close instanceof HTMLButtonElement) || !(back instanceof HTMLButtonElement)
    || back.disabled || close.disabled || !actionSlot?.contains(controls)
    || headerSlot?.parentElement !== title || nav.parentElement !== panel || content.parentElement !== panel
    || close.parentElement !== header || panel.children.length !== 2 || nav.children.length !== 2
    || content.children.length !== 2 || header.children.length !== 2 || list.tagName !== 'DIV'
    || options.tagName !== 'DIV' || !header.contains(closeSlot) || !panel.contains(title)) {
    return null
  }
  const buttons = [...list.children]
  const current = buttons.filter(element => element.getAttribute('aria-current') === 'true')
  const sections = owned('[data-slot="settings.section"]')
  if (buttons.some(element => !(element instanceof HTMLButtonElement))
    || current.length !== (buttons.length > 0 ? 1 : 0)
    || sections.length !== (buttons.length > 0 ? 1 : 0)
    || sections.some(element => element.parentElement !== options)) {
    return null
  }
  return {
    panel,
    overlay,
    nav,
    title,
    list,
    content,
    header,
    actions,
    close,
    options,
    controls,
    back,
    current: current[0] instanceof HTMLButtonElement ? current[0] : null,
  }
}

export function isForegroundSettingsPanel(panel: HTMLElement): boolean {
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"]')]
    .filter(element => element.closest('[hidden], [inert], [aria-hidden="true"]') === null)
    .at(-1) === panel
}

export function findMobileSettingsPanel(): MobileSettingsNodes | null {
  const panels = [...document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)]
    .map(resolveMobileSettingsPanel)
    .filter((nodes): nodes is MobileSettingsNodes => nodes !== null)
  return panels.length === 1 ? panels[0] : null
}

export function applySettingsPresentation(nodes: MobileSettingsNodes, view: MobileSettingsView, patch: ReturnType<typeof createSettingsAttributePatch>): void {
  for (const name of ['overlay', 'nav', 'title', 'list', 'content', 'header', 'actions', 'close', 'options'] as const)
    patch.set(nodes[name], `data-dsh-mobile-settings-${name}`, '')
  patch.set(nodes.panel, 'data-dsh-mobile-settings', '')
  patch.set(nodes.panel, 'data-dsh-mobile-settings-view', view)
  for (const [element, hidden] of [[nodes.list, view === 'detail'], [nodes.options, view === 'menu'], [nodes.controls, view === 'menu']] as const) {
    patch.set(element, 'hidden', hidden ? '' : null)
    if (element !== nodes.controls)
      patch.set(element, 'inert', hidden ? '' : null)
  }
}

export function createSettingsAttributePatch() {
  const changes = new Map<HTMLElement, Map<string, { previous: string | null, written: string | null }>>()
  return {
    set(element: HTMLElement, name: string, value: string | null): void {
      let attributes = changes.get(element)
      if (attributes === undefined) {
        attributes = new Map()
        changes.set(element, attributes)
      }
      const previous = attributes.get(name)
      if (previous !== undefined && element.getAttribute(name) !== previous.written)
        return
      if (previous === undefined)
        attributes.set(name, { previous: element.getAttribute(name), written: value })
      else
        previous.written = value
      if (element.getAttribute(name) === value)
        return
      if (value === null)
        element.removeAttribute(name)
      else
        element.setAttribute(name, value)
    },
    isIntact(): boolean {
      for (const [element, attributes] of changes) {
        for (const [name, { written }] of attributes) {
          if (element.getAttribute(name) !== written)
            return false
        }
      }
      return true
    },
    restore(): void {
      for (const [element, attributes] of changes) {
        for (const [name, { previous, written }] of attributes) {
          if (element.getAttribute(name) !== written)
            continue
          if (previous === null)
            element.removeAttribute(name)
          else
            element.setAttribute(name, previous)
        }
      }
      changes.clear()
    },
  }
}
