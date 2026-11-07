// @vitest-environment jsdom
import type { NavbarProps } from '@/layout/navbar/navbar'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Shell } from './shell'

const mocks = vi.hoisted(() => ({
  navbar: vi.fn<(props: NavbarProps) => void>(),
  shortcuts: { rows: [] },
  setShortcuts: vi.fn(),
  dshStyle: { frame: { background: 'rgb(10, 20, 30)' }, sidebar: { background: 'rgb(40, 50, 60)' } },
  setDshStyle: vi.fn(),
  harness: { markHostedReady: vi.fn(), status: 'ready', serviceHealthy: true, serviceRunning: true, webviewKey: 0, webviewLoaded: false, webviewAlive: false, webviewError: false, webviewSrc: 'http://127.0.0.1:3081', startupPhase: 'process-boot', busyAction: null },
  recovery: { recovery: { required: false } },
  emit: vi.fn().mockResolvedValue(undefined),
  getAllWindows: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  action: null as null | ((event: { actionId?: string, inputValue?: string, extra?: { tag?: string, sessionId?: string, windowLabel?: string, sourceOrigin?: string, deliveryKey?: string } }) => Promise<void>),
  clicked: null as null | ((event: { data?: { tag?: string, sessionId?: string, windowLabel?: string, sourceOrigin?: string, deliveryKey?: string } }) => Promise<void>),
  window: {
    label: 'window-2',
    isMinimized: vi.fn().mockResolvedValue(false),
    isVisible: vi.fn().mockResolvedValue(true),
    isFocused: vi.fn().mockResolvedValue(true),
    unminimize: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks.window, getAllWindows: mocks.getAllWindows }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler)
    return () => mocks.listeners.delete(event)
  },
  emitTo: (target: unknown, event: string, payload?: unknown) => {
    expect(target).toEqual({ kind: 'Window', label: mocks.window.label })
    return mocks.emit(event, payload)
  },
}))
vi.mock('@/hooks/use-notification-action', () => ({ useNotificationAction: (handler: typeof mocks.action) => {
  mocks.action = handler
} }))
vi.mock('@/hooks/use-notification-clicked', () => ({ useNotificationClicked: (handler: typeof mocks.clicked) => {
  mocks.clicked = handler
} }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows' }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value, defineStore: (value: unknown) => value }))
vi.mock('@/store', () => ({ store: { harness: mocks.harness, recovery: mocks.recovery } }))
vi.mock('@/hooks/use-appearance', () => ({ useAppearance: () => '' }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [mocks.dshStyle, mocks.setDshStyle] }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => vi.fn() }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('@/hooks/use-dsh-shortcuts', () => ({
  DSH_VIEW_COMMANDS: [],
  shortcutHint: vi.fn(),
  useDshShortcuts: () => [mocks.shortcuts, mocks.setShortcuts],
}))
vi.mock('@/hooks/use-listen', () => ({ useListen: (event: string, handler: (event: { payload: unknown }) => void) => {
  mocks.listeners.set(event, handler)
} }))
vi.mock('@/ui/plugin/recovery', () => ({ Recovery: () => null }))
vi.mock('./startup/setup', () => ({ Setup: () => null }))
vi.mock('./startup/preinstall', () => ({ PreinstallSetup: () => null }))
vi.mock('./navbar/full-sidebar-navbar', () => ({ FullSidebarNavbar: () => <div data-testid="full-sidebar-navbar" /> }))
vi.mock('./navbar/navbar', () => ({
  Navbar: (props: NavbarProps) => {
    mocks.navbar(props)
    return null
  },
}))
vi.mock('./harness/content', () => ({
  HarnessContent: ({ srcOverride }: { srcOverride?: string | null }) => (
    <div data-src={srcOverride ?? 'http://127.0.0.1:3081'} title="Harness" />
  ),
}))

function installLocalStorage() {
  const items = new Map<string, string>()
  const storage: Storage = {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, String(value)),
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}

function resetNotificationSources() {
  const storage = window.localStorage as Storage & { clear?: () => void }
  if (typeof storage.clear === 'function') {
    storage.clear()
    return
  }
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index)
    if (key !== null)
      storage.removeItem(key)
  }
}

function navbar() {
  return mocks.navbar.mock.lastCall![0]
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.window.label = 'window-2'
  window.location.hash = ''
  installLocalStorage()
  resetNotificationSources()
  window.localStorage.setItem('dsh-notification-source:window-3', 'http://127.0.0.1:3081')
  window.localStorage.setItem('dsh-notification-source:window-1', 'http://127.0.0.1:3081')
  Object.assign(mocks.harness, { status: 'ready', serviceHealthy: true, webviewSrc: 'http://127.0.0.1:3081' })
  mocks.recovery.recovery.required = false
  mocks.navbar.mockClear()
  mocks.setShortcuts.mockClear()
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.emit.mockResolvedValue(undefined)
  mocks.getAllWindows.mockResolvedValue([{ label: 'window-3' }, mocks.window])
  mocks.window.isMinimized.mockResolvedValue(false)
  mocks.window.isVisible.mockResolvedValue(true)
  mocks.window.isFocused.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  delete (globalThis as Record<string, unknown>).__DSH_NAVIGATION__
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['ready', 'timeout'])('mirrors frame and sidebar reports until the full-sidebar cover reveals on %s', (reveal) => {
  ;(globalThis as Record<string, unknown>).__DSH_NAVIGATION__ = { presentation: 'full-sidebar' }
  const view = render(<Shell />)
  const cover = view.getByTestId('dsh-full-sidebar-cover')
  expect(cover.style.background).toBe('rgb(40, 50, 60)')
  expect(view.getByTestId('full-sidebar-navbar')).toBeTruthy()
  expect(view.container.querySelector('main')?.style.background).toBe('rgb(10, 20, 30)')
  const payload = { frame: null, sidebar: { background: 'red' }, colorScheme: 'light' }
  act(() => mocks.listeners.get('dsh://style')!({ payload }))
  expect(mocks.setDshStyle).toHaveBeenCalledExactlyOnceWith(payload)
  act(() => {
    if (reveal === 'ready')
      mocks.listeners.get('dsh://full-sidebar:ready')!({ payload: undefined })
    else
      vi.advanceTimersByTime(15_000)
  })
  expect(view.queryByTestId('dsh-full-sidebar-cover')).toBeNull()
})

it('sends sidebar and settings actions through the registered Tauri event contracts', () => {
  render(<Shell />)
  act(() => {
    navbar().onToggleSidebar?.()
    navbar().onOpenMachineManager?.()
    navbar().onOpenRemoteAccess?.()
  })
  expect(mocks.emit).toHaveBeenCalledWith('dsh://sidebar:toggle', undefined)
  expect(mocks.emit).toHaveBeenCalledWith('dsh://settings:open', { section: 'dsh-tauri-remote', tab: 'machines' })
  expect(mocks.emit).toHaveBeenCalledWith('dsh://settings:open', { section: 'dsh-tauri-remote', tab: 'access' })
})

it('returns to local content before opening remote settings after plugin readiness', () => {
  render(<Shell />)
  act(() => navbar().onRemoteChange('https://remote.test', null))
  act(() => navbar().onOpenMachineManager?.())
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://settings:open', expect.anything())
  act(() => mocks.listeners.get('dsh://appearance:ready')!({ payload: undefined }))
  expect(mocks.emit).toHaveBeenCalledWith('dsh://settings:open', { section: 'dsh-tauri-remote', tab: 'machines' })
})

it.each([
  ['click', ''],
  ['action', ''],
  ['click', 'https://next.test/?token=next'],
  ['action', 'https://next.test/?token=next'],
])('delivers hosted %s notifications from the current document while the pending target is %s', async (kind, target) => {
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.stubGlobal('location', new URL('https://hosted.test/?token=current'))
  mocks.harness.webviewSrc = ''
  render(<Shell />)
  act(() => navbar().onRemoteChange(target, null))
  const metadata = { tag: 'hosted-tag', sessionId: 'hosted-session', windowLabel: 'window-2', sourceOrigin: 'https://hosted.test' }
  await act(async () => {
    if (kind === 'click')
      await mocks.clicked!({ data: metadata })
    else
      await mocks.action!({ actionId: 'approve', extra: metadata })
    await vi.advanceTimersByTimeAsync(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'https://hosted.test' } })
  })
  expect(window.localStorage.getItem('dsh-notification-source:window-2')).toBe('https://hosted.test')
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([
    ['dsh://notification-clicked', kind === 'click'
      ? { tag: 'hosted-tag', sessionId: 'hosted-session', sourceOrigin: 'https://hosted.test' }
      : { tag: 'hosted-tag', sessionId: 'hosted-session', sourceOrigin: 'https://hosted.test', action: 'approve', inputValue: undefined }],
  ])
})

it('coalesces duplicate notification actions without losing the response text', async () => {
  render(<Shell />)
  await act(async () => {
    await mocks.action!({ actionId: 'reply', inputValue: 'answer', extra: { tag: 'session-tag', sourceOrigin: 'http://127.0.0.1:3081' } })
    await mocks.action!({ actionId: 'reply', extra: { tag: 'session-tag', sourceOrigin: 'http://127.0.0.1:3081' } })
    vi.advanceTimersByTime(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([
    ['dsh://notification-clicked', { tag: 'session-tag', sourceOrigin: 'http://127.0.0.1:3081', action: 'reply', inputValue: 'answer' }],
  ])
  expect(mocks.window.show).not.toHaveBeenCalled()
})

it('keeps actions with a reused tag and different interaction identities separate', async () => {
  render(<Shell />)
  const extra = { tag: 'reused-tag', sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081', windowLabel: 'window-2' }
  await act(async () => {
    await mocks.action!({ actionId: 'reply', inputValue: 'old reply', extra: { ...extra, deliveryKey: 'interaction-old' } })
    await mocks.action!({ actionId: 'reply', extra: { ...extra, deliveryKey: 'interaction-current' } })
    await vi.advanceTimersByTimeAsync(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: extra.sourceOrigin } })
  })
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([
    ['dsh://notification-clicked', { tag: 'reused-tag', sessionId: 'session-1', sourceOrigin: extra.sourceOrigin, deliveryKey: 'interaction-old', action: 'reply', inputValue: 'old reply' }],
    ['dsh://notification-clicked', { tag: 'reused-tag', sessionId: 'session-1', sourceOrigin: extra.sourceOrigin, deliveryKey: 'interaction-current', action: 'reply', inputValue: undefined }],
  ])
})

it('activates a minimized window before delivering a native notification click', async () => {
  mocks.window.isMinimized.mockResolvedValue(true)
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { tag: 'session-tag', sessionId: 'session-1', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081' } })
    expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.window.unminimize).toHaveBeenCalledOnce()
  expect(mocks.window.show).toHaveBeenCalledOnce()
  expect(mocks.window.setFocus).toHaveBeenCalledOnce()
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([
    ['dsh://notification-clicked', { tag: 'session-tag', sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081' }],
  ])
})

it('ignores native notification clicks and actions owned by another live window', async () => {
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { tag: 'session-tag', sessionId: 'session-1', windowLabel: 'window-3', sourceOrigin: 'http://127.0.0.1:3081' } })
    await mocks.action!({ actionId: 'approve', extra: { tag: 'session-tag', windowLabel: 'window-3', sourceOrigin: 'http://127.0.0.1:3081' } })
    vi.advanceTimersByTime(250)
  })
  expect(mocks.window.show).not.toHaveBeenCalled()
  expect(mocks.window.setFocus).not.toHaveBeenCalled()
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
})

it.each(['window-closed', undefined])('elects one live shell for notification owner %s', async (windowLabel) => {
  mocks.getAllWindows.mockResolvedValue([{ label: 'popup' }, { label: 'window-3' }, mocks.window])
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { tag: 'historical', sessionId: 'session-old', windowLabel, sourceOrigin: 'http://127.0.0.1:3081' } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.window.show).toHaveBeenCalledOnce()
  expect(mocks.emit).toHaveBeenCalledWith('dsh://notification-clicked', { tag: 'historical', sessionId: 'session-old', sourceOrigin: 'http://127.0.0.1:3081' })
  mocks.window.show.mockClear()
  mocks.emit.mockClear()
  mocks.getAllWindows.mockResolvedValue([mocks.window, { label: 'window-1' }, { label: 'popup' }])
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'session-old', windowLabel, sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.window.show).not.toHaveBeenCalled()
  expect(mocks.emit).not.toHaveBeenCalled()
})

it.each(['click', 'action'])('waits for a live notification owner with unknown source before handling its cold %s once', async (kind) => {
  window.localStorage.setItem('dsh-notification-source:window-3', '')
  const metadata = { tag: 'owner-tag', deliveryKey: 'owner-interaction', sessionId: 'owner-session', windowLabel: 'window-3', sourceOrigin: 'http://127.0.0.1:3081' }
  const otherShell = render(<Shell />)
  await act(async () => {
    if (kind === 'click')
      await mocks.clicked!({ data: metadata })
    else
      await mocks.action!({ actionId: 'approve', extra: metadata })
    await vi.advanceTimersByTimeAsync(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: metadata.sourceOrigin } })
  })
  expect(mocks.window.show).not.toHaveBeenCalled()
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
  otherShell.unmount()
  mocks.window.label = 'window-3'
  mocks.harness.webviewSrc = ''
  const ownerShell = render(<Shell />)
  await act(async () => {
    if (kind === 'click')
      await mocks.clicked!({ data: metadata })
    else
      await mocks.action!({ actionId: 'approve', extra: metadata })
  })
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
  await act(async () => {
    mocks.harness.webviewSrc = metadata.sourceOrigin
    ownerShell.rerender(<Shell />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: metadata.sourceOrigin } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: metadata.sourceOrigin } })
  })
  const payload = kind === 'click'
    ? { tag: 'owner-tag', sessionId: 'owner-session', sourceOrigin: metadata.sourceOrigin }
    : { tag: 'owner-tag', sessionId: 'owner-session', deliveryKey: 'owner-interaction', action: 'approve', inputValue: undefined, sourceOrigin: metadata.sourceOrigin }
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([['dsh://notification-clicked', payload]])
  expect(mocks.window.show).toHaveBeenCalledTimes(kind === 'click' ? 1 : 0)
})

it.each(['http://127.0.0.1:4000', undefined])('rejects a notification from incompatible or unknown source %s even for its owner', async (sourceOrigin) => {
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'wrong-host', windowLabel: 'window-2', sourceOrigin } })
    await mocks.action!({ actionId: 'approve', extra: { tag: 'wrong-host', windowLabel: 'window-2', sourceOrigin } })
    vi.advanceTimersByTime(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.window.show).not.toHaveBeenCalled()
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
})

it('takes over only matching origins when other profile and remote shells sort first', async () => {
  mocks.getAllWindows.mockResolvedValue([{ label: 'main' }, { label: 'remote-1' }, { label: 'window-3' }, mocks.window])
  window.localStorage.setItem('dsh-notification-source:main', 'http://127.0.0.1:4000')
  window.localStorage.setItem('dsh-notification-source:remote-1', 'https://remote.test')
  window.localStorage.setItem('dsh-notification-source:window-3', 'http://127.0.0.1:4000')
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'same-profile', windowLabel: 'window-3', sourceOrigin: 'http://127.0.0.1:3081' } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.window.show).toHaveBeenCalledOnce()
  expect(mocks.emit).toHaveBeenCalledWith('dsh://notification-clicked', { tag: undefined, sessionId: 'same-profile', sourceOrigin: 'http://127.0.0.1:3081' })
})

it('retains queued local clicks while the owning shell displays a remote host', async () => {
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'local-session', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  act(() => navbar().onRemoteChange('https://remote.test/?token=secret', null))
  await act(async () => {
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'https://remote.test' } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(window.localStorage.getItem('dsh-notification-source:window-2')).toBe('https://remote.test')
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
  act(() => navbar().onRemoteChange('', null))
  await act(async () => {
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.emit).toHaveBeenCalledWith('dsh://notification-clicked', { tag: undefined, sessionId: 'local-session', sourceOrigin: 'http://127.0.0.1:3081' })
})

it.each([
  ['click', 'http://127.0.0.1:3081'],
  ['action', 'http://127.0.0.1:3081'],
  ['click', 'https://other.test'],
  ['action', 'https://other.test'],
])('buffers cold %s until the source becomes %s', async (kind, sourceOrigin) => {
  mocks.harness.webviewSrc = ''
  const view = render(<Shell />)
  const metadata = { tag: 'cold-tag', deliveryKey: 'cold-interaction', sessionId: 'cold-session', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081' }
  await act(async () => {
    if (kind === 'click')
      await mocks.clicked!({ data: metadata })
    else
      await mocks.action!({ actionId: 'approve', extra: metadata })
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(mocks.window.show).not.toHaveBeenCalled()
  expect(mocks.emit).not.toHaveBeenCalledWith('dsh://notification-clicked', expect.anything())
  await act(async () => {
    mocks.harness.webviewSrc = sourceOrigin
    view.rerender(<Shell />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin } })
  })
  const deliveries = mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')
  if (sourceOrigin === 'http://127.0.0.1:3081') {
    expect(deliveries).toEqual([['dsh://notification-clicked', kind === 'click'
      ? { tag: 'cold-tag', sessionId: 'cold-session', sourceOrigin }
      : { tag: 'cold-tag', sessionId: 'cold-session', deliveryKey: 'cold-interaction', action: 'approve', inputValue: undefined, sourceOrigin }]])
    expect(mocks.window.show).toHaveBeenCalledTimes(kind === 'click' ? 1 : 0)
  }
  else {
    expect(deliveries).toEqual([])
    expect(mocks.window.show).not.toHaveBeenCalled()
  }
})

it('retains a notification when delivery fails and retries on the next ready event', async () => {
  const error = new Error('guest unavailable')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<Shell />)
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'session-1', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  mocks.emit.mockRejectedValueOnce(error)
  await act(async () => {
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(console.error).toHaveBeenCalledWith('[notification] delivery failed:', error)
  await act(async () => {
    await mocks.clicked!({ data: { sessionId: 'session-2', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  await act(async () => {
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
    mocks.listeners.get('dsh://notification-ready')!({ payload: { sourceOrigin: 'http://127.0.0.1:3081' } })
  })
  expect(mocks.emit.mock.calls.filter(([event]) => event === 'dsh://notification-clicked')).toEqual([
    ['dsh://notification-clicked', { tag: undefined, sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081' }],
    ['dsh://notification-clicked', { tag: undefined, sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081' }],
    ['dsh://notification-clicked', { tag: undefined, sessionId: 'session-2', sourceOrigin: 'http://127.0.0.1:3081' }],
  ])
})
