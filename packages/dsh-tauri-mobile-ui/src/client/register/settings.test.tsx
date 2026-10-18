// @vitest-environment jsdom
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
import type { MobileSettingsPresentation } from '../types/settings'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_SETTINGS_MEDIA } from '../constants'
import { registerMobileSettings } from './settings'

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/register'),
  ...await import('../../../../dsh-tauri/src/client/locale'),
  ...await import('../../../../dsh-tauri/src/client/utils/device'),
}))

vi.mock('dsh-tauri-ui/client', async () => ({
  ...await import('../../../../dsh-tauri-ui/src/client/components/icon'),
  ...await import('../../../../dsh-tauri-ui/src/client/components/icons'),
  Button: ({ icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }) => (
    <button type="button" {...props}>
      {icon}
      {children}
    </button>
  ),
}))

interface DialogFixture {
  overlay: HTMLElement
  panel: HTMLElement
  title: HTMLElement
  list: HTMLElement
  options: HTMLElement
  actionSlot: HTMLElement
  close: HTMLButtonElement
  current: HTMLButtonElement | null
}

interface ActionRegistration {
  name: string
  id: string
  order: number
  locale: string
  registrant: string
  inject: () => { presentation: MobileSettingsPresentation }
}

let matches = true
let media: MediaQueryList
let mediaListeners: Set<() => void>
const disposers: Array<() => void> = []
let sequence = 0

function fixture(labels = ['General', 'Models'], selected = 0): DialogFixture {
  const overlay = document.createElement('div')
  const titleId = `settings:r${++sequence}:`
  // Official SettingsRoot.tsx:67-104: slots and dialog semantics, not CSS-module hashes.
  overlay.innerHTML = `<div aria-hidden="true"></div><div role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1"><nav><div id="${titleId}" tabindex="-1"><div data-slot="settings.header">Settings</div></div><div>${labels.map((label, index) => `<button type="button"${index === selected ? ' aria-current="true"' : ''}><span>${label}</span></button>`).join('')}</div></nav><div><div><div><div data-slot="settings.action"></div></div><button type="button"><span><div data-slot="settings.close">Close settings</div></span></button></div><div>${labels.length === 0 ? '' : '<div data-slot="settings.section"><input aria-label="Setting draft" value="initial"><button type="button">Save</button></div>'}</div></div></div>`
  document.body.append(overlay)
  const panel = overlay.querySelector<HTMLElement>('[role="dialog"]')!
  const title = document.getElementById(titleId)!
  const list = title.nextElementSibling as HTMLElement
  return {
    overlay,
    panel,
    title,
    list,
    options: panel.querySelector<HTMLElement>('[data-slot="settings.section"]')?.parentElement
      ?? panel.lastElementChild!.lastElementChild as HTMLElement,
    actionSlot: panel.querySelector<HTMLElement>('[data-slot="settings.action"]')!,
    close: panel.querySelector<HTMLButtonElement>('[data-slot="settings.close"]')!.closest('button')!,
    current: list.querySelector<HTMLButtonElement>('[aria-current="true"]'),
  }
}

function register(initial?: DialogFixture) {
  let registration: ActionRegistration | undefined
  let Component: ComponentType<{ presentation: MobileSettingsPresentation }> | undefined
  const roots: Array<ReturnType<typeof render>> = []
  const inject = vi.fn((_name: string, activate: () => () => void) => activate())
  const slotsRegister = vi.fn((options: ActionRegistration, component: typeof Component) => {
    registration = options
    Component = component
    return () => roots.forEach(root => root.unmount())
  })
  const ctx = { slots: { inject, register: slotsRegister } }
  const dispose = registerMobileSettings.call({ ctx })
  disposers.push(dispose)
  const mount = (dialog: DialogFixture): void => {
    if (!Component || !registration)
      throw new Error('Mobile settings action was not registered')
    roots.push(render(<Component {...registration.inject()} />, { container: dialog.actionSlot }))
  }
  if (initial)
    mount(initial)
  return {
    dispose,
    mount,
    inject,
    slotsRegister,
    presentation: (): MobileSettingsPresentation => {
      if (!registration)
        throw new Error('Mobile settings presentation is unavailable')
      return registration.inject().presentation
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await vi.runOnlyPendingTimersAsync()
  })
}

function launcher(legacy = false): HTMLButtonElement {
  const slot = document.createElement('div')
  if (!legacy)
    slot.setAttribute('data-slot', 'settings.launcher')
  slot.innerHTML = `<button type="button" aria-haspopup="dialog">${legacy ? '<span data-slot="settings.trigger">Open settings</span>' : 'Open settings'}</button>`
  document.body.append(slot)
  return slot.firstElementChild as HTMLButtonElement
}

async function openFromLauncher(legacy = false) {
  const handle = register()
  let dialog: DialogFixture | undefined
  act(() => {
    fireEvent.click(launcher(legacy))
    dialog = fixture()
    handle.mount(dialog)
  })
  await flush()
  if (!dialog)
    throw new Error('Settings dialog was not opened')
  return { handle, dialog }
}

function back(dialog: DialogFixture): HTMLButtonElement {
  return dialog.panel.querySelector<HTMLButtonElement>('[data-dsh-mobile-settings-back]')!
}

function setCurrent(dialog: DialogFixture, index: number): HTMLButtonElement {
  const buttons = [...dialog.list.querySelectorAll<HTMLButtonElement>('button')]
  buttons.forEach((button, current) => {
    if (current === index)
      button.setAttribute('aria-current', 'true')
    else
      button.removeAttribute('aria-current')
  })
  dialog.current = buttons[index]
  return buttons[index]
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  matches = true
  mediaListeners = new Set()
  media = {
    get matches() { return matches },
    media: MOBILE_SETTINGS_MEDIA,
    onchange: null,
    addEventListener: vi.fn((_name, listener) => mediaListeners.add(listener as () => void)),
    removeEventListener: vi.fn((_name, listener) => mediaListeners.delete(listener as () => void)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
})

afterEach(async () => {
  act(() => disposers.splice(0).forEach(dispose => dispose()))
  cleanup()
  document.body.innerHTML = ''
  await Promise.resolve()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mobile settings presentation', () => {
  it('registers only an additive official action with managed teardown', async () => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    expect(handle.inject).toHaveBeenCalledWith('settings.action', expect.any(Function))
    expect(handle.slotsRegister).toHaveBeenCalledTimes(1)
    expect(handle.slotsRegister.mock.calls[0][0]).toMatchObject({
      name: 'settings.action',
      id: 'dsh-tauri-mobile-ui: back',
      order: -100,
      locale: 'dsh-tauri-mobile-ui',
      registrant: 'dsh-tauri-mobile-ui',
    })
    expect(dialog.title.textContent).toBe('Settings')
    expect(dialog.panel.getAttribute('aria-labelledby')).toBe(dialog.title.id)
    expect(back(dialog).getAttribute('aria-label')).toBe('Back to settings categories')
    expect(mediaListeners.size).toBe(1)
    act(handle.dispose)
    expect(mediaListeners.size).toBe(0)
    expect(dialog.actionSlot.childElementCount).toBe(0)
  })

  it.each([false, true])('opens categories only for its observed launcher intent (legacy=%s)', async (legacy) => {
    const { dialog, handle } = await openFromLauncher(legacy)
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('menu')
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.list.hasAttribute('inert')).toBe(false)
    expect(dialog.options.hidden).toBe(true)
    expect(dialog.options.hasAttribute('inert')).toBe(true)
    expect(dialog.panel.querySelector<HTMLElement>('[data-dsh-mobile-settings-controls]')!.hidden).toBe(true)
    expect(handle.presentation().getSnapshot()).toEqual({ ready: true, view: 'menu', title: 'General' })
  })

  it.each([0, 1])('preserves unknown-entry deep links in details, including first row (%s)', async (selected) => {
    const dialog = fixture(['General', 'Models'], selected)
    const handle = register(dialog)
    await flush()
    expect(handle.presentation().getSnapshot()).toEqual({ ready: true, view: 'detail', title: selected === 0 ? 'General' : 'Models' })
    expect(dialog.list.hidden).toBe(true)
    expect(dialog.list.hasAttribute('inert')).toBe(true)
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.options.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(back(dialog))
  })

  it('lets native category clicks select before showing details', async () => {
    const { dialog } = await openFromLauncher()
    const nativeSelect = vi.fn(() => setCurrent(dialog, 1))
    const button = dialog.list.children[1] as HTMLButtonElement
    button.addEventListener('click', nativeSelect)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => fireEvent(button, click))
    await flush()
    expect(nativeSelect).toHaveBeenCalledTimes(1)
    expect(click.defaultPrevented).toBe(false)
    expect(dialog.current).toBe(button)
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
    expect(dialog.panel.querySelector('[data-dsh-mobile-settings-section-title]')!.textContent).toBe('Models')
    expect(document.activeElement).toBe(back(dialog))
  })

  it('shows details for a native re-selection without requiring a DOM mutation', async () => {
    const { dialog } = await openFromLauncher()
    act(() => fireEvent.click(dialog.current!))
    await flush()
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
    expect(document.activeElement).toBe(back(dialog))
  })

  it('returns to categories without remounting the official draft', async () => {
    const dialog = fixture()
    register(dialog)
    await flush()
    const input = dialog.options.querySelector<HTMLInputElement>('input')!
    input.value = 'unsaved local draft'
    act(() => fireEvent.click(back(dialog)))
    await flush()
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('menu')
    expect(dialog.options.querySelector('input')).toBe(input)
    expect(input.value).toBe('unsaved local draft')
    expect(document.activeElement).toBe(dialog.current)
    act(() => fireEvent.click(dialog.current!))
    await flush()
    expect(dialog.options.querySelector('input')).toBe(input)
    expect(input.value).toBe('unsaved local draft')
  })

  it('updates the current label without inventing a settings section state', async () => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    act(() => {
      dialog.current!.querySelector('span')!.textContent = '常规设置'
    })
    await flush()
    expect(handle.presentation().getSnapshot()).toEqual({ ready: true, view: 'detail', title: '常规设置' })
    expect(dialog.panel.querySelector('[data-dsh-mobile-settings-section-title]')!.textContent).toBe('常规设置')
    expect(dialog.current!.getAttribute('aria-current')).toBe('true')
  })

  it('follows externally changed native selection while on categories', async () => {
    const { dialog, handle } = await openFromLauncher()
    act(() => {
      setCurrent(dialog, 1)
    })
    await flush()
    expect(handle.presentation().getSnapshot()).toEqual({ ready: true, view: 'detail', title: 'Models' })
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.list.hidden).toBe(true)
  })

  it('keeps an empty official ledger in categories with its accessible title', async () => {
    const dialog = fixture([])
    const handle = register(dialog)
    await flush()
    expect(handle.presentation().getSnapshot()).toEqual({ ready: true, view: 'menu', title: '' })
    expect(dialog.panel.getAttribute('aria-labelledby')).toBe(dialog.title.id)
    expect(document.activeElement).toBe(dialog.title)
    expect(dialog.options.hidden).toBe(true)
    expect(dialog.close.hidden).toBe(false)
  })

  it('restores native attributes and focus when leaving the phone media query', async () => {
    const dialog = fixture()
    dialog.list.setAttribute('hidden', 'original')
    const handle = register(dialog)
    await flush()
    act(() => {
      matches = false
      mediaListeners.forEach(listener => listener())
    })
    await flush()
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(dialog.list.getAttribute('hidden')).toBe('original')
    expect(dialog.list.hasAttribute('inert')).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(handle.presentation().getSnapshot()).toEqual({ ready: false, view: 'detail', title: '' })
    expect(document.activeElement).toBe(dialog.close)
    act(() => {
      matches = true
      fireEvent(window, new Event('resize'))
    })
    await flush()
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
  })

  it('never arms desktop or non-touch settings', async () => {
    matches = false
    const dialog = fixture()
    register(dialog)
    await flush()
    expect(window.matchMedia).toHaveBeenCalledWith(MOBILE_SETTINGS_MEDIA)
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.panel.querySelector<HTMLElement>('[data-dsh-mobile-settings-controls]')!.hidden).toBe(true)
  })

  it('yields atomically to an active bridge mobile stylesheet and resumes when removed', async () => {
    const dialog = fixture()
    register(dialog)
    await flush()
    const bridge = document.createElement('style')
    bridge.id = 'dsh-bridge-mobile-styles'
    act(() => {
      document.head.append(bridge)
    })
    await flush()
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(document.activeElement).toBe(dialog.current)
    act(() => {
      bridge.remove()
    })
    await flush()
    expect(dialog.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
  })

  it.each(['hidden', 'inert'])('abandons a panel when a later owner takes its %s attribute', async (attribute) => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    const controls = dialog.panel.querySelector<HTMLElement>('[data-dsh-mobile-settings-controls]')!
    act(() => {
      dialog.list.setAttribute(attribute, 'later-owner')
      handle.presentation().back()
    })
    await flush()
    expect(dialog.list.getAttribute(attribute)).toBe('later-owner')
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.options.hasAttribute('inert')).toBe(false)
    expect(controls.hidden).toBe(true)
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(handle.presentation().getSnapshot().ready).toBe(false)
    expect(document.activeElement).toBe(dialog.close)
    act(() => fireEvent(window, new Event('resize')))
    await flush()
    expect(dialog.list.getAttribute(attribute)).toBe('later-owner')
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    act(() => dialog.overlay.remove())
    const replacement = fixture()
    act(() => handle.mount(replacement))
    await flush()
    expect(replacement.panel.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
  })

  it('fails closed for two proven settings dialogs and restores the previous panel', async () => {
    const first = fixture()
    const handle = register(first)
    await flush()
    const second = fixture()
    act(() => handle.mount(second))
    await flush()
    expect(first.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(second.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(first.list.hidden).toBe(false)
    expect(first.options.hidden).toBe(false)
    expect(handle.presentation().getSnapshot().ready).toBe(false)
  })

  it('restores the entire patch when official structure becomes ambiguous', async () => {
    const dialog = fixture()
    register(dialog)
    await flush()
    const duplicate = document.createElement('div')
    duplicate.setAttribute('data-slot', 'settings.action')
    act(() => dialog.panel.append(duplicate))
    await flush()
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.list.hasAttribute('data-dsh-mobile-settings-list')).toBe(false)
  })

  it('does not steal focus or Back from a foreground nested dialog', async () => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('aria-modal', 'true')
    nested.innerHTML = '<input aria-label="Nested input">'
    act(() => {
      dialog.options.append(nested)
      nested.querySelector<HTMLInputElement>('input')!.focus()
      handle.presentation().back()
    })
    await flush()
    expect(document.activeElement).toBe(nested.firstElementChild)
    expect(handle.presentation().getSnapshot().view).toBe('detail')
  })

  it('ignores hidden nested menus when deciding whether Back is foreground', async () => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.hidden = true
    act(() => {
      dialog.options.append(menu)
      handle.presentation().back()
    })
    await flush()
    expect(handle.presentation().getSnapshot().view).toBe('menu')
    expect(document.activeElement).toBe(dialog.current)
  })

  it('restores native focus before unregistering a focused additive Back control', async () => {
    const dialog = fixture()
    const handle = register(dialog)
    await flush()
    expect(document.activeElement).toBe(back(dialog))
    act(handle.dispose)
    await flush()
    expect(document.activeElement).toBe(dialog.current)
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
  })

  it('does not turn an expired launcher click into a later external menu entry', async () => {
    const handle = register()
    act(() => fireEvent.click(launcher()))
    await flush()
    const dialog = fixture()
    act(() => handle.mount(dialog))
    await flush()
    expect(handle.presentation().getSnapshot().view).toBe('detail')
  })

  it('cancels a queued category transition on disposal without recreating ownership', async () => {
    const { dialog, handle } = await openFromLauncher()
    act(() => {
      fireEvent.click(dialog.current!)
      handle.dispose()
    })
    await flush()
    expect(dialog.panel.hasAttribute('data-dsh-mobile-settings')).toBe(false)
    expect(dialog.list.hidden).toBe(false)
    expect(dialog.options.hidden).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
