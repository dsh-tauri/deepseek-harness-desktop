// @vitest-environment jsdom
import type { ComponentType } from 'react'
import type { LifecycleController } from '../../../../dsh-tauri/src/client/controller'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../dsh-tauri/src/client/controller'
import { defineAdapter } from '../../../../dsh-tauri/src/client/register/index.adapter'

import { registerMobileSidebar } from './sidebar'

interface TestContext {
  layout: {
    toggleSidebar: () => void
    selectPanel: (panel: string | null) => void
  }
  slots: {
    inject: (slot: string, activate: () => () => void) => () => void
    register: (options: unknown, component: ComponentType) => () => void
  }
}

const mocks = vi.hoisted(() => ({
  mobile: true,
  component: undefined as ComponentType | undefined,
  parentHandler: undefined as ((message: { type?: string }) => void) | undefined,
  invokeParent: vi.fn(),
  listenParent: vi.fn(),
  sessions: undefined as unknown,
  sessionListeners: new Set<() => void>(),
  startSession: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  defineLocale: (namespace: string, dictionaries: Record<string, unknown>) => ({
    NS: namespace,
    text: (key: string) => key,
    useLocale: () => 'en',
    registerLocale: vi.fn(),
    ...dictionaries,
  }),
  MOBILE_MEDIA_QUERIES: ['(hover: none)', '(any-pointer: coarse)', '(any-hover: none)'],
  detectMobileDevice: () => mocks.mobile,
  invokeParent: mocks.invokeParent,
  listenParent: mocks.listenParent,
  defineRegister: (setup: (controller: LifecycleController, ctx: unknown, adapter: unknown) => void) => function (this: unknown) {
    const controller = createLifecycleController()
    setup(controller, this, {
      sessions: {
        list: {
          getSnapshot: () => mocks.sessions,
          subscribe: (listener: () => void) => {
            mocks.sessionListeners.add(listener)
            return () => mocks.sessionListeners.delete(listener)
          },
        },
      },
      startSession: mocks.startSession,
    })
    return () => controller.dispose()
  },
}))

vi.mock('../locales', () => ({
  locale: {
    NS: 'dsh-tauri-mobile-ui',
    text: (key: string) => ({
      'toggle.open': 'Open sidebar',
      'toggle.close': 'Close sidebar',
      'shade.close': 'Close sidebar',
      'navbar.label': 'Conversation navigation',
      'session.new': 'New Session',
      'session.failed': 'Unable to start a session. Please try again.',
    }[key] ?? key),
    useLocale: () => 'en',
    registerLocale: vi.fn(),
  },
}))

vi.mock('dsh-tauri-ui/client', async () => ({
  ...await import('../../../../dsh-tauri-ui/src/client/components/icons'),
  ...await import('../../../../dsh-tauri-ui/src/client/components/icon'),
}))

const disposers: Array<() => void> = []

function setupFrame(): { sidebar: HTMLElement, center: HTMLElement, main: HTMLElement, overlay: HTMLElement } {
  document.body.innerHTML = '<div class="pI_x6G_frame" data-rightbar-collapsed><div class="pI_x6G_sidebarCol"></div><div class="pI_x6G_centerCol"><div data-slot="main"><div data-conversation-scroll></div></div></div><div data-shell-overlay></div></div>'
  const frame = document.querySelector<HTMLElement>('[data-shell-overlay]')?.parentElement
  if (frame === null || frame === undefined)
    throw new Error('Missing layout frame')
  return {
    sidebar: frame.querySelector<HTMLElement>('[class$="_sidebarCol"]')!,
    center: frame.querySelector<HTMLElement>('[class$="_centerCol"]')!,
    main: frame.querySelector<HTMLElement>('[data-slot="main"]')!,
    overlay: frame.querySelector<HTMLElement>('[data-shell-overlay]')!,
  }
}

function renderOverlay(overlay: HTMLElement): void {
  const Component = mocks.component
  if (Component === undefined)
    throw new Error('Sidebar overlay was not registered')
  render(<Component />, { container: overlay })
}

function touch(target: Element, type: string, x: number, y: number, time: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const point = { identifier: 1, clientX: x, clientY: y }
  Object.defineProperties(event, {
    touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [point] },
    changedTouches: { value: [point] },
    timeStamp: { value: time },
  })
  fireEvent(target, event)
  return event
}

function pointer(target: Element, type: string, x: number, y: number, time: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'mouse' },
    isPrimary: { value: true },
    button: { value: 0 },
    buttons: { value: type === 'pointerup' ? 0 : 1 },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: time },
  })
  fireEvent(target, event)
  return event
}

function register(layout: Partial<TestContext['layout']> = {}): { dispose: () => void, ctx: TestContext } {
  const ctx: TestContext = {
    layout: {
      toggleSidebar: vi.fn(),
      selectPanel: vi.fn(),
      ...layout,
    },
    slots: {
      inject: (_slot, activate) => activate(),
      register: (_options, component) => {
        mocks.component = component
        return vi.fn()
      },
    },
  }
  const dispose = registerMobileSidebar.call(ctx)
  disposers.push(dispose)
  return { dispose, ctx }
}

beforeEach(() => {
  const inertValues = new WeakMap<HTMLElement, boolean>()
  Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get(this: HTMLElement) {
      return inertValues.get(this) ?? false
    },
    set(this: HTMLElement, value: boolean) {
      inertValues.set(this, value)
    },
  })
  cleanup()
  document.documentElement.removeAttribute('data-dsh-mobile-sidebar')
  document.documentElement.removeAttribute('data-dsh-mobile-sidebar-open')
  document.body.innerHTML = ''
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390, writable: true })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
  mocks.mobile = true
  mocks.component = undefined
  mocks.parentHandler = undefined
  mocks.invokeParent.mockReset()
  mocks.listenParent.mockReset()
  mocks.sessions = { ids: [], byId: {} }
  mocks.sessionListeners.clear()
  mocks.startSession.mockReset().mockResolvedValue({ status: 'started' })
  mocks.listenParent.mockImplementation((handler: (message: { type?: string }) => void) => {
    mocks.parentHandler = handler
    return vi.fn()
  })
})

afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose())
  cleanup()
  vi.restoreAllMocks()
})

describe('registerMobileSidebar', () => {
  it('uses the same sidebar glyph as the desktop navbar and an outlined circle-plus without button wrappers', () => {
    const { overlay } = setupFrame()
    register()
    renderOverlay(overlay)
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    const plus = screen.getByRole('button', { name: 'New Session' })
    const sidebarPath = 'M6 3.5h6A1.5 1.5 0 0 1 13.5 5v6a1.5 1.5 0 0 1-1.5 1.5H6zm-1.5 0H4A1.5 1.5 0 0 0 2.5 5v6A1.5 1.5 0 0 0 4 12.5h.5zM1 5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3z'
    const circlePlusPath = 'M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0M8.75 5.5a.75.75 0 0 0-1.5 0v1.75H5.5a.75.75 0 1 0 0 1.5h1.75v1.75a.75.75 0 0 0 1.5 0V8.75h1.75a.75.75 0 0 0 0-1.5H8.75z'
    expect(toggle.querySelector('path')?.getAttribute('d')).toBe(sidebarPath)
    expect(plus.querySelector('path')?.getAttribute('d')).toBe(circlePlusPath)
    expect(toggle.closest('button')).toBeNull()
    expect(plus.closest('button')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.querySelector('path')?.getAttribute('d')).toBe(sidebarPath)
  })

  it('keeps navigation in the moving center while only drawer/main content becomes inert', () => {
    const { sidebar, center, main, overlay } = setupFrame()
    sidebar.setAttribute('aria-hidden', 'false')
    main.setAttribute('aria-hidden', 'false')
    const { dispose, ctx } = register()
    renderOverlay(overlay)
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })

    expect(toggle.tagName.toLowerCase()).toBe('svg')
    expect(toggle.closest('button')).toBeNull()
    expect(center.firstElementChild).toBe(toggle.closest('[data-dsh-mobile-navbar-host]'))
    expect(toggle.closest('[data-shell-overlay]')).toBeNull()
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
    expect(sidebar.inert).toBe(true)
    expect(main.inert).toBe(false)
    toggle.focus()
    fireEvent.click(toggle)

    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(true)
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
    expect(sidebar.inert).toBe(false)
    expect(main.getAttribute('aria-hidden')).toBe('true')
    expect(main.inert).toBe(true)
    expect(center.inert).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--dsh-mobile-sidebar-width')).toBe('319px')
    expect(document.documentElement.style.getPropertyValue('--dsh-mobile-sidebar-shadow')).toBe('')
    expect(mocks.invokeParent).toHaveBeenCalledWith({ type: 'dsh://sidebar:collapsed', collapsed: false })

    fireEvent.click(overlay.querySelector('[data-dsh-mobile-sidebar-shade]')!)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
    expect(document.activeElement).toBe(toggle)
    expect(mocks.invokeParent).toHaveBeenLastCalledWith({ type: 'dsh://sidebar:collapsed', collapsed: true })

    dispose()
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false)
    expect(document.querySelector('[data-dsh-mobile-navbar-host]')).toBeNull()
    expect(sidebar.getAttribute('aria-hidden')).toBe('false')
    expect(sidebar.inert).toBe(false)
    expect(main.getAttribute('aria-hidden')).toBe('false')
    expect(main.inert).toBe(false)
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    expect(mocks.sessionListeners.size).toBe(0)
  })

  it.each(['touch', 'pointer'])('leaves %s swipes to content without opening or closing the sidebar', (source) => {
    const { sidebar, main, overlay } = setupFrame()
    const row = document.createElement('button')
    row.textContent = 'Existing session'
    const select = vi.fn()
    row.addEventListener('click', select)
    sidebar.append(row)
    register()
    renderOverlay(overlay)
    const send = source === 'touch' ? touch : pointer
    send(main, source === 'touch' ? 'touchstart' : 'pointerdown', 100, 200, 100)
    expect(send(main, `${source}move`, 300, 202, 300).defaultPrevented).toBe(false)
    send(main, source === 'touch' ? 'touchend' : 'pointerup', 320, 202, 400)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--dsh-mobile-sidebar-width')).toBe('319px')
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    send(row, source === 'touch' ? 'touchstart' : 'pointerdown', 220, 200, 500)
    expect(send(row, `${source}move`, 20, 202, 700).defaultPrevented).toBe(false)
    send(row, source === 'touch' ? 'touchend' : 'pointerup', 20, 202, 800)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--dsh-mobile-sidebar-width')).toBe('319px')
    fireEvent.click(row)
    expect(select).toHaveBeenCalledTimes(1)
    fireEvent.click(overlay.querySelector('[data-dsh-mobile-sidebar-shade]')!)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
  })

  it('never toggles core preferences to refresh mobile ownership across the desktop breakpoint', async () => {
    setupFrame()
    let desktopWidth = 350
    let narrowExpanded = false
    const toggleSidebar = vi.fn(() => {
      if (window.innerWidth < 1024)
        narrowExpanded = !narrowExpanded
      else
        desktopWidth = desktopWidth === 0 ? 280 : 0
    })
    const { dispose } = register({ toggleSidebar })
    window.innerWidth = 1200
    fireEvent(window, new Event('resize'))
    await act(async () => {
      dispose()
    })
    expect(toggleSidebar).not.toHaveBeenCalled()
    expect(desktopWidth).toBe(350)
    expect(narrowExpanded).toBe(false)
  })

  it('reconciles delayed/replaced frames and restores all owned DOM state on unload', async () => {
    const root = document.documentElement
    root.style.setProperty('--dsh-mobile-sidebar-width', '7px')
    vi.spyOn(root.style, 'getPropertyPriority').mockImplementation(name => name === '--dsh-mobile-sidebar-width' ? 'important' : '')
    const setProperty = vi.spyOn(root.style, 'setProperty')
    const { ctx, dispose } = register()
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    const { center, main, sidebar, overlay } = setupFrame()
    renderOverlay(overlay)
    await waitFor(() => expect(center.querySelector('[data-dsh-mobile-topbar]')).not.toBeNull())
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    toggle.focus()
    fireEvent.click(toggle)
    const replacementMain = document.createElement('div')
    replacementMain.setAttribute('data-slot', 'main')
    main.replaceWith(replacementMain)
    await waitFor(() => expect(replacementMain.inert).toBe(true))
    expect(main.inert).toBe(false)
    const replacementSidebar = document.createElement('div')
    replacementSidebar.className = 'new_sidebarCol'
    sidebar.replaceWith(replacementSidebar)
    await waitFor(() => expect(document.activeElement).toBe(replacementSidebar))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(toggle)
    act(() => dispose())
    expect(replacementMain.inert).toBe(false)
    expect(replacementSidebar.getAttribute('tabindex')).toBeNull()
    expect(root.style.getPropertyValue('--dsh-mobile-sidebar-width')).toBe('7px')
    expect(setProperty).toHaveBeenCalledWith('--dsh-mobile-sidebar-width', '7px', 'important')
    root.style.removeProperty('--dsh-mobile-sidebar-width')
  })

  it('hands the layout back at the desktop breakpoint without leftover navigation', () => {
    const { main, overlay } = setupFrame()
    const { dispose } = register()
    renderOverlay(overlay)
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    window.innerWidth = 1200
    fireEvent(window, new Event('resize'))
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
    expect(document.querySelector('[data-dsh-mobile-navbar-host]')).toBeNull()
    expect(main.inert).toBe(false)
    dispose()
  })

  it('follows active titles, renames, and blank sessions without reading DOM titles', () => {
    const { overlay } = setupFrame()
    mocks.sessions = { current: 'selected', byId: { selected: { title: 'First title', blank: false } } }
    register()
    renderOverlay(overlay)
    const title = document.querySelector('[data-dsh-mobile-navbar-title]')!
    expect(title.textContent).toBe('First title')
    act(() => {
      mocks.sessions = { current: 'selected', byId: { selected: { title: 'Renamed title', blank: false } } }
      mocks.sessionListeners.forEach(listener => listener())
    })
    expect(title.textContent).toBe('Renamed title')
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    act(() => {
      mocks.sessions = { current: 'new', byId: { new: { title: 'Stale title', blank: true } } }
      mocks.sessionListeners.forEach(listener => listener())
    })
    expect(title.textContent).toBe('New Session')
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
  })

  it('creates sessions through the adapter from a naked keyboard-accessible plus icon', async () => {
    const { overlay } = setupFrame()
    const { ctx } = register()
    renderOverlay(overlay)
    const plus = screen.getByRole('button', { name: 'New Session' })
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    expect(plus.tagName.toLowerCase()).toBe('svg')
    expect(plus.closest('button')).toBeNull()
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(true)
    let finish: (result: { status: 'started' }) => void = () => {}
    mocks.startSession.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    fireEvent.keyDown(plus, { key: 'Enter' })
    fireEvent.keyDown(plus, { key: 'Enter', repeat: true })
    fireEvent.click(plus)
    expect(mocks.startSession).toHaveBeenCalledTimes(1)
    expect(plus.getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      finish({ status: 'started' })
    })
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
    expect(plus.getAttribute('aria-disabled')).toBe('false')
    fireEvent.keyDown(plus, { key: ' ' })
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(2))
  })

  it.each(['unavailable', 'rejected'])('keeps failure %s visible and allows retry', async (status) => {
    const { overlay } = setupFrame()
    const { ctx } = register()
    renderOverlay(overlay)
    if (status === 'unavailable')
      mocks.startSession.mockResolvedValueOnce({ status, reason: 'Unavailable test capability' })
    else
      mocks.startSession.mockRejectedValueOnce(new Error('Test navigation failed'))
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Unable to start a session. Please try again.')
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(mocks.startSession).toHaveBeenCalledTimes(2)
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
  })

  it('does not abort pending native navigation when the official startSession returns void', async () => {
    const { overlay } = setupFrame()
    const { ctx } = register()
    renderOverlay(overlay)
    const navigation = new AbortController()
    vi.mocked(ctx.layout.selectPanel).mockImplementation(() => navigation.abort())
    let finishConnect: (id: string) => void = () => {}
    const connect = new Promise<string>((resolve) => {
      finishConnect = resolve
    })
    const selectSession = vi.fn()
    const start = vi.fn(() => {
      void connect.then((id) => {
        if (!navigation.signal.aborted) {
          selectSession(id)
          ctx.layout.selectPanel(null)
        }
      })
    })
    const adapter = defineAdapter({ uiWorkspace: { startSession: start } })
    mocks.startSession.mockImplementation(() => adapter.startSession())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(navigation.signal.aborted).toBe(false)
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
    expect(selectSession).not.toHaveBeenCalled()
    await act(async () => {
      finishConnect('created')
    })
    expect(selectSession).toHaveBeenCalledWith('created')
    expect(ctx.layout.selectPanel).toHaveBeenCalledTimes(1)
  })

  it('does not touch layout or DOM when new-session navigation settles after unload', async () => {
    const { overlay } = setupFrame()
    const { ctx, dispose } = register()
    renderOverlay(overlay)
    let finish: (result: { status: 'started' }) => void = () => {}
    mocks.startSession.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    act(() => dispose())
    await act(async () => {
      finish({ status: 'started' })
    })
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dsh-mobile-navbar-host]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false)
  })

  it('yields to an open rightbar and resumes closed without changing core layout state', async () => {
    const { main, overlay } = setupFrame()
    const frame = overlay.parentElement!
    const { ctx } = register()
    renderOverlay(overlay)
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(main.inert).toBe(true)

    act(() => frame.removeAttribute('data-rightbar-collapsed'))
    await waitFor(() => expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false))
    expect(main.inert).toBe(false)
    expect(document.querySelector('[data-dsh-mobile-navbar-host]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)

    act(() => frame.setAttribute('data-rightbar-collapsed', ''))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInstanceOf(SVGElement))
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(false)
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    expect(ctx.layout.selectPanel).not.toHaveBeenCalled()
  })

  it('does not take ownership when the native rightbar is already visible', () => {
    const { overlay } = setupFrame()
    overlay.parentElement!.removeAttribute('data-rightbar-collapsed')
    register()
    renderOverlay(overlay)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false)
    expect(document.querySelector('[data-dsh-mobile-navbar-host]')).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('maps the host toggle command to the drawer and remains inactive on desktop', () => {
    setupFrame()
    const { dispose } = register()
    const Component = mocks.component
    if (Component === undefined)
      throw new Error('Sidebar overlay was not registered')
    render(<Component />)

    mocks.parentHandler?.({ type: 'dsh://sidebar:toggle' })
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar-open')).toBe(true)

    dispose()
    mocks.mobile = false
    const desktop = register()
    expect(document.documentElement.hasAttribute('data-dsh-mobile-sidebar')).toBe(false)
    desktop.dispose()
  })
})
