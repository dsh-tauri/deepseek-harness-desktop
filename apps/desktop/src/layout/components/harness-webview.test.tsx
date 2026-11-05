// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HarnessWebview } from './harness-webview'

interface NativeState { label: string, loaded: boolean, alive: boolean, crashed: boolean }
interface BootFailure { label: string, detail: string }
type ListenPayload = NativeState | BootFailure
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(),
  decode: vi.fn<() => Promise<void>>(),
  zoom: vi.fn().mockResolvedValue(undefined),
  scaleFactor: vi.fn().mockResolvedValue(1),
  harness: {
    serviceHealthy: true,
    webviewSrc: 'http://127.0.0.1:3081',
    webviewKey: 0,
    showWebviewError: false,
    startupStatusKey: 'status.loading_plugins',
    markWebviewLoaded: vi.fn(),
    markWebviewError: vi.fn(),
    refreshWebview: vi.fn(),
    markWebviewAlive: vi.fn(),
    markWebviewLeaving: vi.fn(),
    markWebviewBootReady: vi.fn(),
    handleWebviewBootFailure: vi.fn(),
  },
  setting: { zoom_factor: 1.25 },
  listeners: new Map<string, (event: { payload: ListenPayload }) => void>(),
  options: new Map<string, unknown>(),
  resize: new Set<() => void>(),
  rect: { x: 24, y: 72, left: 24, top: 72, width: 960, height: 600, right: 984, bottom: 672, toJSON: () => ({}) },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main', scaleFactor: mocks.scaleFactor }) }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@/store', () => ({ store: { harness: mocks.harness, setting: { zoom: mocks.zoom, get zoom_factor() {
  return mocks.setting.zoom_factor
} } } }))
vi.mock('@/hooks/use-listen', () => ({ useListen: (event: string, handler: (event: { payload: ListenPayload }) => void, options?: unknown) => {
  mocks.listeners.set(event, handler)
  mocks.options.set(event, options)
} }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./loadable', () => ({ Loadable: ({ errorMsg }: { errorMsg?: string }) => <div role="status">{errorMsg ?? 'Loading'}</div> }))

function state(payload: Partial<NativeState> = {}) {
  act(() => mocks.listeners.get('harness-webview-state')!({ payload: { label: 'guest-local', loaded: true, alive: true, crashed: false, ...payload } }))
}
function updates() {
  return mocks.invoke.mock.calls.filter(([command]) => command === 'update_harness_webview').map(([, args]) => args)
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.options.clear()
  mocks.resize.clear()
  Object.assign(mocks.harness, { serviceHealthy: true, webviewKey: 0, showWebviewError: false })
  Object.assign(mocks.rect, { x: 24, y: 72, left: 24, top: 72, width: 960, height: 600 })
  mocks.setting.zoom_factor = 1.25
  mocks.scaleFactor.mockResolvedValue(1)
  vi.stubGlobal('devicePixelRatio', 1)
  mocks.decode.mockResolvedValue(undefined)
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: mocks.decode })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
  mocks.invoke.mockImplementation(async command => command === 'prepare_harness_webview' ? 'guest-local' : undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => mocks.rect)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.hidden || this.closest('[hidden]') || this.style.display === 'none' ? [] : [mocks.rect]) as unknown as DOMRectList
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { mocks.resize.add(callback) }
    observe() {}
    disconnect() { mocks.resize.delete(this.callback) }
  })
})
afterEach(async () => {
  cleanup()
  document.body.replaceChildren()
  document.body.style.cssText = ''
  await act(async () => {})
  Reflect.deleteProperty(window, '__DSH_NAVIGATION__')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
})

it('keeps one native registration through StrictMode and a reload during pending preparation', async () => {
  const active = new Map<string, string>()
  let sequence = 0
  let duplicates = 0
  let finishPrepare!: () => void
  let finishRelease: (() => void) | undefined
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'prepare_harness_webview') {
      const url = String(args.url)
      if (active.has(url)) {
        duplicates++
        throw new Error('invalid or duplicate guest registration')
      }
      const label = `guest-${++sequence}`
      active.set(url, label)
      await new Promise<void>((resolve) => {
        finishPrepare = resolve
      })
      return label
    }
    if (command !== 'release_harness_webview')
      return
    await new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    for (const [url, label] of active) {
      if (label === args.label)
        active.delete(url)
    }
  })
  const view = render(<StrictMode><HarnessWebview /></StrictMode>)
  await waitFor(() => expect([...active.values()]).toEqual(['guest-1']))
  expect(duplicates).toBe(0)
  mocks.harness.webviewKey++
  view.rerender(<StrictMode><HarnessWebview /></StrictMode>)
  await act(async () => {})
  expect(duplicates).toBe(0)
  await act(async () => {
    finishPrepare()
  })
  await waitFor(() => expect(finishRelease).toBeTypeOf('function'))
  expect(screen.queryByTitle('Harness')).toBeNull()
  expect([...active.values()]).toEqual(['guest-1'])
  await act(async () => {
    finishRelease!()
  })
  await waitFor(() => expect([...active.values()]).toEqual(['guest-2']))
  await act(async () => {
    finishPrepare()
  })
  expect(screen.getByTitle('Harness').tagName).toBe('DIV')
  expect(duplicates).toBe(0)
  finishRelease = undefined
  view.unmount()
  await waitFor(() => expect(finishRelease).toBeTypeOf('function'))
  await act(async () => {
    finishRelease!()
  })
  expect(active.size).toBe(0)
})

it('creates a native view before showing its placeholder and passes navigation', async () => {
  const navigation = { sessionId: 'existing' }
  Object.defineProperty(window, '__DSH_NAVIGATION__', { configurable: true, value: navigation })
  let finish!: (label: string) => void
  mocks.invoke.mockImplementation(command => command === 'prepare_harness_webview'
    ? new Promise((resolve) => { finish = resolve })
    : Promise.resolve())
  const view = render(<HarnessWebview />)
  expect(screen.queryByTitle('Harness')).toBeNull()
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('prepare_harness_webview', { url: 'http://127.0.0.1:3081', navigation }))
  await act(async () => finish('guest-created'))
  expect(screen.getByTitle('Harness').tagName).toBe('DIV')
  expect(document.querySelector('webview')).toBeNull()
  view.unmount()
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('release_harness_webview', { label: 'guest-created' }))
})

it('keeps preparation failures visible without mounting a native placeholder', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('registration denied'))
  render(<HarnessWebview />)
  expect(await screen.findByText('Error: registration denied')).not.toBeNull()
  expect(screen.queryByTitle('Harness')).toBeNull()
})

it('sends CSS bounds and zoom once, resyncing changed offsets and sizes without duplicate IPC', async () => {
  const view = render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  expect(updates()).toEqual([{ label: 'guest-local', x: 24, y: 72, width: 960, height: 600, visible: true, zoomFactor: 1.25 }])
  fireEvent.resize(window)
  expect(updates()).toHaveLength(1)
  mocks.rect.top = 120
  mocks.rect.width = 800
  act(() => mocks.resize.forEach(callback => callback()))
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ y: 120, width: 800 }))
  mocks.rect.left = 64
  document.body.style.paddingLeft = '64px'
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ x: 64 }))
  mocks.setting.zoom_factor = 1.5
  view.rerender(<HarnessWebview />)
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ zoomFactor: 1.5 }))
})

it('ignores hidden shell overlays and tooltips, and hides a zero-size native view safely', async () => {
  render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  overlay.hidden = true
  document.body.append(overlay)
  const tooltip = document.createElement('div')
  tooltip.setAttribute('role', 'tooltip')
  document.body.append(tooltip)
  await act(async () => {})
  expect(updates().at(-1)).toMatchObject({ visible: true })
  mocks.rect.width = 0
  fireEvent.resize(window)
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ width: 1, visible: false }))
  overlay.remove()
  tooltip.remove()
})

it('subscribes to window-targeted native state, keeping boot readiness separate', async () => {
  render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  expect(mocks.options.get('harness-webview-state')).toEqual({ target: { kind: 'Window', label: 'main' } })
  state()
  expect(mocks.harness.markWebviewLoaded).toHaveBeenCalledOnce()
  expect(mocks.harness.markWebviewAlive).toHaveBeenCalledWith(0)
  expect(mocks.harness.markWebviewBootReady).not.toHaveBeenCalled()
  state({ loaded: false, alive: false })
  expect(mocks.harness.markWebviewLeaving).toHaveBeenCalledOnce()
  state({ loaded: false, alive: false, crashed: true })
  expect(mocks.harness.markWebviewError).toHaveBeenCalledOnce()
})

it('fails the shell with the boot failure page reported by the current guest only', async () => {
  mocks.harness.handleWebviewBootFailure = vi.fn()
  render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  act(() => mocks.listeners.get('dsh://plugin-boot:failed')!({ payload: { label: 'other-guest', detail: 'Failed to load plugins' } }))
  expect(mocks.harness.handleWebviewBootFailure).not.toHaveBeenCalled()
  mocks.harness.webviewKey++
  act(() => mocks.listeners.get('dsh://plugin-boot:failed')!({ payload: { label: 'guest-local', detail: 'Failed to load plugins' } }))
  expect(mocks.harness.handleWebviewBootFailure).not.toHaveBeenCalled()
  mocks.harness.webviewKey = 0
  act(() => mocks.listeners.get('dsh://plugin-boot:failed')!({ payload: { label: 'guest-local', detail: 'Failed to load plugins\ndsh-tauri-kernel: failed' } }))
  expect(mocks.harness.handleWebviewBootFailure).toHaveBeenCalledWith('Failed to load plugins\ndsh-tauri-kernel: failed')
  expect(mocks.options.get('dsh://plugin-boot:failed')).toEqual({ target: { kind: 'Window', label: 'main' } })
})

it('ignores local boot failures for a remote guest', async () => {
  mocks.harness.handleWebviewBootFailure = vi.fn()
  render(<HarnessWebview srcOverride="https://remote.test" />)
  await screen.findByTitle('Harness')
  act(() => mocks.listeners.get('dsh://plugin-boot:failed')!({ payload: { label: 'guest-local', detail: 'Failed to load plugins' } }))
  expect(mocks.harness.handleWebviewBootFailure).not.toHaveBeenCalled()
})

it('rejects stale labels and old generations while reloading', async () => {
  const view = render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  state({ label: 'other-guest' })
  expect(mocks.harness.markWebviewAlive).not.toHaveBeenCalled()
  mocks.harness.webviewKey++
  state()
  expect(mocks.harness.markWebviewLoaded).not.toHaveBeenCalled()
  view.rerender(<HarnessWebview />)
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('release_harness_webview', { label: 'guest-local' }))
})

it('never mutates local health or hides a remote guest because of local errors', async () => {
  mocks.harness.showWebviewError = true
  render(<HarnessWebview srcOverride="https://remote.test" />)
  await screen.findByTitle('Harness')
  state()
  state({ loaded: false, alive: false, crashed: true })
  expect(mocks.harness.markWebviewLoaded).not.toHaveBeenCalled()
  expect(mocks.harness.markWebviewAlive).not.toHaveBeenCalled()
  expect(mocks.harness.markWebviewLeaving).not.toHaveBeenCalled()
  expect(mocks.harness.markWebviewError).not.toHaveBeenCalled()
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ visible: true }))
})

it('serializes pending native updates before releasing the view', async () => {
  let finish!: () => void
  mocks.invoke.mockImplementation((command) => {
    if (command === 'prepare_harness_webview')
      return Promise.resolve('guest-local')
    if (command === 'update_harness_webview' && !finish)
      return new Promise<void>((resolve) => { finish = resolve })
    return Promise.resolve()
  })
  const view = render(<HarnessWebview />)
  await screen.findByTitle('Harness')
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  document.body.append(overlay)
  await act(async () => {})
  expect(updates()).toHaveLength(1)
  state()
  await act(async () => finish())
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ visible: true }))
  view.unmount()
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('release_harness_webview', { label: 'guest-local' }))
  overlay.remove()
})

it('releases a stale prepared URL before creating the selected remote URL', async () => {
  const pending = new Map<string, (label: string) => void>()
  mocks.invoke.mockImplementation((command, args) => command === 'prepare_harness_webview'
    ? new Promise((resolve) => { pending.set(String(args.url), resolve) })
    : Promise.resolve())
  const view = render(<HarnessWebview srcOverride="https://alpha.test" />)
  await waitFor(() => expect(pending.has('https://alpha.test')).toBe(true))
  view.rerender(<HarnessWebview srcOverride="https://beta.test" />)
  await act(async () => pending.get('https://alpha.test')!('old-guest'))
  expect(screen.queryByTitle('Harness')).toBeNull()
  expect(mocks.invoke).toHaveBeenCalledWith('release_harness_webview', { label: 'old-guest' })
  await act(async () => pending.get('https://beta.test')!('new-guest'))
  expect(screen.getByTitle('Harness').tagName).toBe('DIV')
  expect(updates().at(-1)).toMatchObject({ label: 'new-guest' })
})

it('converts actual shell zoom to DIP and rechecks DPI on resize independently of guest zoom', async () => {
  vi.stubGlobal('devicePixelRatio', 2.5)
  mocks.scaleFactor.mockResolvedValue(2)
  const view = render(<HarnessWebview />)
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ x: 30, y: 90, width: 1200, height: 750, zoomFactor: 1.25 }))
  mocks.setting.zoom_factor = 1.5
  view.rerender(<HarnessWebview />)
  await waitFor(() => expect(updates().at(-1)).toMatchObject({ x: 30, width: 1200, zoomFactor: 1.5 }))
  vi.stubGlobal('devicePixelRatio', 1.25)
  mocks.scaleFactor.mockResolvedValue(1)
  fireEvent.resize(window)
  await act(async () => {})
  expect(updates().at(-1)).toMatchObject({ x: 30, width: 1200 })
  expect(mocks.scaleFactor).toHaveBeenCalled()
})
