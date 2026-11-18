// @vitest-environment jsdom
import type { EventTarget } from '@tauri-apps/api/event'
import type { ComponentProps } from 'react'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { Shell } from '@/layout/shell'
import { shortcutsFeature } from '../../../../../packages/builtin-plugin-tauri/src/client/register/shortcuts'
import { Navbar } from './navbar'

const { store, userAgent, openOverlay, openUrl, toggleDevtools, emitEvent } = vi.hoisted(() => {
  const userAgent = navigator.userAgent
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Macintosh' })
  return {
    userAgent,
    openOverlay: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn<(args: { url: string }) => Promise<void>>(),
    toggleDevtools: vi.fn<() => Promise<void>>(),
    emitEvent: vi.fn(),
    store: {
      harness: { status: 'ready', serviceHealthy: true, webviewSrc: 'http://127.0.0.1:3081', markHostedReady: vi.fn(), markWebviewLoaded: vi.fn(), markWebviewAlive: vi.fn(), markWebviewBootReady: vi.fn() },
      recovery: { recovery: { required: false } },
      desktopUpdater: { updateInfo: null, check: vi.fn().mockResolvedValue(null) },
      setting: { zoom: vi.fn() },
    },
  }
})

vi.mock('@/store', () => ({ store }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value, defineStore: (value: unknown) => value }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'macos' }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQuery: () => ({ data: [] }),
    useQueryClient: () => ({ ensureQueryData: () => Promise.resolve('dsh-tauri') }),
  }
})
vi.mock('@overlastic/react', () => ({ useOverlay: () => openOverlay }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{}] }))
vi.mock('@/hooks/use-appearance', () => ({ useAppearance: () => '' }))
vi.mock('@/hooks/use-notification-action', () => ({ useNotificationAction: vi.fn() }))
vi.mock('@/hooks/use-notification-clicked', () => ({ useNotificationClicked: vi.fn() }))
vi.mock('@tauri-apps/api/event', async (importOriginal) => {
  const event = await importOriginal<typeof import('@tauri-apps/api/event')>()
  return { ...event, emitTo: (target: EventTarget | string, name: string, payload?: unknown) => {
    expect(target).toEqual({ kind: 'Window', label: 'main' })
    emitEvent(name, payload)
    return Promise.resolve()
  } }
})
vi.mock('@/ui/dialog/about', () => ({ DesktopAboutDialog: () => null }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('@/ui/dialog/update', () => ({ DesktopUpdateDialog: () => null }))
vi.mock('@/utils/clipboard', () => ({ writeClipboardText: vi.fn() }))
vi.mock('@/utils/toast', () => ({ toast: vi.fn() }))
vi.mock('@/ui/plugin/recovery', () => ({ Recovery: () => null }))
vi.mock('@/layout/startup/setup', () => ({ Setup: () => null }))
vi.mock('@/layout/startup/preinstall', () => ({ PreinstallSetup: () => null }))
vi.mock('@/layout/remote/switcher', () => ({
  RemoteSwitcher: ({ onChange }: { onChange: (url: string, tint: string | null) => void }) => (
    <>
      <button onClick={() => onChange('http://127.0.0.1:4001', null)}>Remote alpha</button>
      <button onClick={() => onChange('http://127.0.0.1:4002', null)}>Remote beta</button>
      <button onClick={() => onChange('', null)}>Local</button>
    </>
  ),
}))

interface Listener {
  event: string
  target: EventTarget
  handler: number
}

interface MenuEntry {
  id: string
  enabled: boolean
  shortcut: string | null
}

function CatalogRegistration({ onCommit }: { onCommit: () => void }) {
  useDshShortcuts()
  useLayoutEffect(onCommit)
  return null
}

const listeners = new Map<number, Listener>()
let menuEntries: MenuEntry[]
const closedWindows: string[] = []

function nativeEvent(event: string, payload?: unknown, label?: string) {
  const runtime = window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } }
  for (const [id, listener] of listeners) {
    if (listener.event !== event)
      continue
    if (label !== undefined && listener.target.kind !== 'Any' && (!('label' in listener.target) || listener.target.label !== label))
      continue
    runtime.__TAURI_INTERNALS__.runCallback(listener.handler, { event, id, payload })
  }
}

function webview() {
  return screen.getByTestId<HTMLElement>('dsh-harness-webview')
}

function reportShortcuts() {
  act(() => nativeEvent('dsh://shortcuts', {
    rows: [{ id: 'sidebar.left.toggle', label: 'Sidebar', keys: ['⌥', '⌘', 'B'], available: true }],
  }))
}

beforeEach(() => {
  listeners.clear()
  closedWindows.length = 0
  emitEvent.mockClear()
  openOverlay.mockClear()
  openUrl.mockReset().mockResolvedValue(undefined)
  toggleDevtools.mockReset().mockResolvedValue(undefined)
  menuEntries = []
  store.harness.status = 'ready'
  store.harness.serviceHealthy = true
  store.setting.zoom.mockClear()
  mockWindows('main')
  mockIPC((command, args) => {
    switch (command) {
      case 'open_external_url':
        return openUrl(args as { url: string })
      case 'toggle_devtools':
        return toggleDevtools()
      case 'host_harness_document':
        return
      case 'plugin:event|listen': {
        const listener = args as unknown as Listener
        listeners.set(listener.handler, listener)
        return listener.handler
      }
      case 'plugin:event|unlisten':
        listeners.delete((args as { eventId: number }).eventId)
        return
      case 'sync_view_menu':
        menuEntries = structuredClone((args as { entries: MenuEntry[] }).entries)
        return
      case 'plugin:window|close':
        closedWindows.push((args as { label: string }).label)
        return
      case 'plugin:window|is_fullscreen':
      case 'plugin:window|is_maximized':
        return false
      default:
        throw new Error(`Unexpected native command: ${command}`)
    }
  })
  const { result, unmount } = renderHook(useDshShortcuts)
  act(() => result.current[1]({ rows: [] }))
  unmount()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

afterAll(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
})

describe('shell remote share availability', () => {
  it.each(['starting', 'preinstall', 'error'])('hides remote sharing while the local service is %s', (status) => {
    store.harness.status = status
    render(<Shell />)
    expect(screen.queryByRole('button', { name: 'remote.share' })).toBeNull()
  })

  it('hides remote sharing when local health is lost and restores it after recovery', () => {
    const view = render(<Shell />)
    expect(screen.getByRole('button', { name: 'remote.share' })).not.toBeNull()
    store.harness.serviceHealthy = false
    view.rerender(<Shell />)
    expect(screen.queryByRole('button', { name: 'remote.share' })).toBeNull()
    store.harness.serviceHealthy = true
    view.rerender(<Shell />)
    expect(screen.getByRole('button', { name: 'remote.share' })).not.toBeNull()
  })

  it('keeps remote sharing independent of SSH and LAN/tunnel settings while the service bridge is live', () => {
    render(<Navbar onRemoteChange={vi.fn()} onToggleSidebar={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'remote.share' })).not.toBeNull()
  })
})

describe('native View menu state', () => {
  it('leaves a ready hosted document clickable before the DSH frame mounts', () => {
    vi.stubGlobal('__DSH_HOSTED__', true)
    vi.stubGlobal('__DSH_BOOT__', { entries: [] })
    const css = document.createElement('style')
    css.textContent = '.pointer-events-none{pointer-events:none}.pointer-events-auto{pointer-events:auto}'
    document.head.append(css)
    try {
      const view = render(<Shell />)
      const main = view.container.querySelector('main')!
      expect(getComputedStyle(main).pointerEvents).toBe('none')
      fireEvent.click(screen.getByRole('button', { name: 'Remote alpha' }))
      expect(screen.queryByTestId('dsh-harness-webview')).toBeNull()
      expect(getComputedStyle(main).pointerEvents).toBe('none')
      fireEvent.click(screen.getByRole('button', { name: 'Local' }))
      expect(getComputedStyle(main).pointerEvents).toBe('none')
      store.harness.status = 'preinstall'
      view.rerender(<Shell />)
      expect(getComputedStyle(main).pointerEvents).toBe('auto')
    }
    finally {
      css.remove()
    }
  })

  it('displays remote content in a hosted shell and returns to the local document', async () => {
    vi.stubGlobal('__DSH_HOSTED__', true)
    vi.stubGlobal('__DSH_BOOT__', { entries: [] })
    const frame = document.createElement('div')
    frame.className = 'layout_frame'
    frame.append(document.createElement('section'))
    document.body.append(frame)
    await act(async () => {
      render(<Shell />)
    })
    expect(screen.getByTestId('dsh-hosted-document')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remote alpha' }))
    expect(screen.queryByTestId('dsh-harness-webview')).toBeNull()
    expect(screen.getByTestId('dsh-hosted-document')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remote beta' }))
    expect(screen.queryByTestId('dsh-harness-webview')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Local' }))
    expect(screen.getByTestId('dsh-hosted-document')).not.toBeNull()
    expect(screen.queryByTestId('dsh-harness-webview')).toBeNull()
  })

  it('settles equivalent catalogs whose registration order changes during rendering', () => {
    let reports = 0
    const rows = [
      { id: 'sidebar.left.toggle', label: 'Sidebar', keys: ['⌥', '⌘', 'B'], available: true },
      { id: 'terminal.new', label: 'Terminal', keys: ['⌘', 'J'], available: true },
    ]
    function ReorderedCatalog() {
      useDshShortcuts()
      useLayoutEffect(() => {
        reports++
        if (reports > 60)
          throw new Error('equivalent reordered shortcut catalogs caused render feedback')
        nativeEvent('dsh://shortcuts', { rows: reports % 2 ? rows : [...rows].reverse() })
      })
      return null
    }
    render(
      <>
        <Shell />
        <ReorderedCatalog />
      </>,
    )
    reportShortcuts()
    expect(reports).toBeLessThan(10)
  })

  it('retains meaningful shortcut catalog updates after normalizing registration order', () => {
    render(<Shell />)
    const shortcuts = renderHook(useDshShortcuts)
    reportShortcuts()
    act(() => nativeEvent('dsh://shortcuts', { rows: [
      { id: 'terminal.new', label: 'Terminal', keys: ['⌘', 'J'], available: true },
      { id: 'sidebar.left.toggle', label: 'Changed sidebar', keys: ['⌘', 'B'], available: false },
    ] }))
    expect(shortcuts.result.current[0].rows).toEqual([
      { id: 'sidebar.left.toggle', label: 'Changed sidebar', keys: ['⌘', 'B'], available: false },
      { id: 'terminal.new', label: 'Terminal', keys: ['⌘', 'J'], available: true },
    ])
  })

  it('settles shortcut registrations that publish transient empty catalogs during a render', () => {
    vi.useFakeTimers()
    vi.stubGlobal('isTauri', true)
    emitEvent.mockImplementation((event: string, payload: unknown) => nativeEvent(event, payload))
    const rows = [{ id: 'sidebar.left.toggle', label: 'Sidebar', keys: ['⌥', '⌘', 'B'], binding: { code: 'KeyB', modifiers: ['alt', 'meta'] } }]
    let current = rows
    let reports = 0
    const subscribers = new Set<() => void>()
    const catalog = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        subscribers.add(listener)
        return () => subscribers.delete(listener)
      },
    }
    const dispose = shortcutsFeature.call({ get: () => ({ catalog }) })
    function rebindCatalog() {
      reports++
      if (reports > 60)
        throw new Error('transient shortcut registrations caused render feedback')
      current = []
      for (const listener of subscribers) listener()
      current = rows
      for (const listener of subscribers) listener()
    }
    try {
      render(
        <>
          <Shell />
          <CatalogRegistration onCommit={rebindCatalog} />
        </>,
      )
      reportShortcuts()
      act(() => vi.advanceTimersByTime(20))
      expect(reports).toBeLessThan(10)
      expect(menuEntries.find(entry => entry.id === 'desktop-toggle-sidebar')).toEqual({
        id: 'desktop-toggle-sidebar',
        enabled: true,
        shortcut: '⌥ ⌘ B',
      })
    }
    finally {
      act(dispose)
      emitEvent.mockReset()
    }
  })

  it('keeps the shortcut snapshot stable when the native catalog repeats unchanged rows', () => {
    render(<Shell />)
    const shortcuts = renderHook(useDshShortcuts)
    reportShortcuts()
    const previous = shortcuts.result.current[0]
    reportShortcuts()
    expect(shortcuts.result.current[0]).toBe(previous)
  })

  it('closes only the window targeted by a native DSH event', async () => {
    render(<Shell />)
    await waitFor(() => expect([...listeners.values()].find(listener => listener.event === 'dsh://window:close')?.target).toEqual({ kind: 'Window', label: 'main' }))
    act(() => nativeEvent('dsh://window:close', undefined, 'other'))
    expect(closedWindows).toEqual([])
    act(() => nativeEvent('dsh://window:close', undefined, 'main'))
    await waitFor(() => expect(closedWindows).toEqual(['main']))
  })

  it('restores enabled commands and hints after the language change rebuilds the native menu', async () => {
    render(<Shell />)
    reportShortcuts()
    await waitFor(() => expect(menuEntries[0]).toEqual({ id: 'desktop-toggle-sidebar', enabled: true, shortcut: '⌥ ⌘ B' }))
    menuEntries = menuEntries.map(entry => ({ ...entry, enabled: false, shortcut: null }))
    act(() => nativeEvent('macos-menu-rebuilt'))
    await waitFor(() => expect(menuEntries[0]).toEqual({ id: 'desktop-toggle-sidebar', enabled: true, shortcut: '⌥ ⌘ B' }))
    expect(menuEntries.slice(1).map(entry => entry.enabled)).toEqual([false, false, false])
  })

  it('keeps the remote catalog and command bridge during a local service restart', async () => {
    const view = render(<Shell />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote alpha' }))
    reportShortcuts()
    const frame = webview()
    store.harness.serviceHealthy = false
    view.rerender(<Shell />)
    act(() => nativeEvent('tauri://focus', null, 'main'))
    await waitFor(() => expect(menuEntries[0].enabled).toBe(true))
    act(() => nativeEvent('macos-menu-action', 'desktop-toggle-sidebar', 'main'))
    expect(emitEvent.mock.calls.filter(([event]) => event === 'dsh://view:command')).toEqual([['dsh://view:command', { command: 'sidebar.left.toggle' }]])
    expect(webview()).toBe(frame)
    store.harness.serviceHealthy = true
    view.rerender(<Shell />)
    await waitFor(() => expect(menuEntries[0].enabled).toBe(true))
  })

  it('clears the local catalog when the local service becomes unavailable', async () => {
    const view = render(<Shell />)
    reportShortcuts()
    store.harness.serviceHealthy = false
    view.rerender(<Shell />)
    await waitFor(() => expect(menuEntries.map(entry => entry.enabled)).toEqual([false, false, false, false]))
    store.harness.serviceHealthy = true
    view.rerender(<Shell />)
    expect(menuEntries[0]).toEqual({ id: 'desktop-toggle-sidebar', enabled: false, shortcut: null })
  })

  it.each(['Remote beta', 'Local'])('clears the previous remote catalog when switching to %s', async (destination) => {
    render(<Shell />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote alpha' }))
    reportShortcuts()
    fireEvent.click(screen.getByRole('button', { name: destination }))
    await waitFor(() => expect(menuEntries[0]).toEqual({ id: 'desktop-toggle-sidebar', enabled: false, shortcut: null }))
    reportShortcuts()
    await waitFor(() => expect(menuEntries[0].enabled).toBe(true))
  })

  it('clears the remote catalog when the shell removes the webview', async () => {
    const view = render(<Shell />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote alpha' }))
    reportShortcuts()
    store.harness.status = 'error'
    view.rerender(<Shell />)
    expect(screen.queryByTestId('dsh-harness-webview')).toBeNull()
    await waitFor(() => expect(menuEntries[0].enabled).toBe(false))
    store.harness.status = 'ready'
    view.rerender(<Shell />)
    expect(menuEntries[0].shortcut).toBeNull()
  })
})

describe('native View menu recipients', () => {
  function mountWindow(label: string, props: Partial<ComponentProps<typeof Navbar>> = {}) {
    mockWindows(label)
    return render(<Navbar onRemoteChange={vi.fn()} {...props} />)
  }

  it.each(['main', 'remote-alpha'])('delivers a targeted core command only to %s', async (label) => {
    const main = vi.fn()
    const remote = vi.fn()
    mountWindow('main', { onViewCommand: main })
    mountWindow('remote-alpha', { onViewCommand: remote })
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toHaveLength(2))
    act(() => nativeEvent('macos-menu-action', 'desktop-open-terminal', label))
    expect(main.mock.calls).toEqual(label === 'main' ? [['terminal.new']] : [])
    expect(remote.mock.calls).toEqual(label === 'remote-alpha' ? [['terminal.new']] : [])
  })

  it('opens the task manager only in the targeted shell window', async () => {
    mountWindow('main')
    mountWindow('remote-alpha')
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toHaveLength(2))
    act(() => nativeEvent('macos-menu-action', 'desktop-task-manager', 'remote-alpha'))
    expect(openOverlay).toHaveBeenCalledExactlyOnceWith()
  })

  it('applies a targeted zoom action once when two shell windows are open', async () => {
    mountWindow('main')
    mountWindow('remote-alpha')
    act(() => nativeEvent('macos-menu-action', 'desktop-zoom-in', 'remote-alpha'))
    expect(store.setting.zoom).toHaveBeenCalledExactlyOnceWith('increase')
  })

  it('unsubscribes the recipient when its shell window closes', async () => {
    const command = vi.fn()
    const view = mountWindow('remote-alpha', { onViewCommand: command })
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toHaveLength(1))
    view.unmount()
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toEqual([]))
    act(() => nativeEvent('macos-menu-action', 'desktop-open-terminal', 'remote-alpha'))
    expect(command).not.toHaveBeenCalled()
  })
})

describe('native Help menu links', () => {
  it.each([
    ['desktop-documentation', 'https://dshtauri.mintlify.site'],
    ['desktop-feedback', 'https://github.com/dsh-tauri/deepseek-harness-desktop/issues'],
    ['desktop-harness-feedback', 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'],
  ])('opens the expected destination for %s', async (action, url) => {
    render(<Navbar onRemoteChange={vi.fn()} />)
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toHaveLength(1))

    act(() => nativeEvent('macos-menu-action', action, 'main'))

    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith({ url }))
  })

  it('toggles the shell window developer tools from the native item', async () => {
    render(<Navbar onRemoteChange={vi.fn()} />)
    await waitFor(() => expect([...listeners.values()].filter(listener => listener.event === 'macos-menu-action')).toHaveLength(1))

    act(() => nativeEvent('macos-menu-action', 'desktop-toggle-devtools', 'main'))

    await waitFor(() => expect(toggleDevtools).toHaveBeenCalledExactlyOnceWith())
  })
})
