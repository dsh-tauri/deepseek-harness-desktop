import type { ReactNode } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'
import type { NotificationFocus } from '@/store/modules/connection'
import { createContext as createVmContext, runInContext } from 'node:vm'
import { act, createElement } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  appState: { currentState: 'active' },
  appListeners: new Set<() => void>(),
  backListeners: new Set<() => boolean>(),
  navigation: { isFocused: vi.fn<() => boolean>() },
  randomUUID: vi.fn<() => string>(),
  openURL: vi.fn<(url: string) => Promise<void>>(),
  getPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  requestPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  setNotificationChannelAsync: vi.fn<(...args: unknown[]) => Promise<null>>(),
  scheduleNotificationAsync: vi.fn<(...args: unknown[]) => Promise<string>>(),
  cancelAnimation: vi.fn(),
  setTheme: vi.fn<(theme: 'light' | 'dark' | 'system') => void>(),
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Modal: 'Modal',
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
  Linking: { openURL: native.openURL },
  AppState: {
    get currentState() { return native.appState.currentState },
    addEventListener: (_event: string, listener: () => void) => {
      native.appListeners.add(listener)
      return { remove: () => {
        native.appListeners.delete(listener)
      } }
    },
  },
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      native.backListeners.add(listener)
      return { remove: () => {
        native.backListeners.delete(listener)
      } }
    },
  },
}))
vi.mock('uniwind', () => ({ Uniwind: { setTheme: native.setTheme } }))
// 文案与 store 现在都经过 i18n；node 环境无法真正加载 expo-localization（缺 __DEV__），设备区域固定为 zh-CN。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
// store 模块经 valtio-define persist 插件依赖 AsyncStorage，node 环境用最小实现顶替。
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }))
vi.mock('expo-router', () => ({ useNavigation: () => native.navigation }))
vi.mock('expo-crypto', () => ({ randomUUID: native.randomUUID }))
vi.mock('expo-network', () => ({ getIpAddressAsync: vi.fn<() => Promise<string>>() }))
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
  getPermissionsAsync: native.getPermissionsAsync,
  requestPermissionsAsync: native.requestPermissionsAsync,
  setNotificationChannelAsync: native.setNotificationChannelAsync,
  scheduleNotificationAsync: native.scheduleNotificationAsync,
}))
vi.mock('heroui-native/hooks', () => ({ useThemeColor: (names: string | string[]) => Array.isArray(names) ? names.map(() => '#ffffff') : '#ffffff' }))
vi.mock('heroui-native/button', async () => {
  const { createElement } = await import('react')
  function Button({ children, ...props }: { children?: ReactNode }) {
    return createElement('Button', props, children)
  }
  return { Button }
})
vi.mock('react-native-lucide', () => ({ ArrowLeft: 'Icon', Hand: 'Icon' }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { View: 'AnimatedView' },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (style: () => unknown) => style(),
    withTiming: (value: number) => value,
    withDelay: (_delay: number, value: number) => value,
    withRepeat: (value: number) => value,
    withSequence: (...values: number[]) => values.at(-1),
    cancelAnimation: native.cancelAnimation,
  }
})
vi.mock('react-native-webview', async () => {
  const { Component, createElement } = await import('react')
  class WebView extends Component<Record<string, unknown>> {
    constructor(props: Record<string, unknown>) {
      super(props)
      Object.assign(this, {
        injectJavaScript: vi.fn<(script: string) => void>(),
        goBack: vi.fn<() => void>(),
      })
    }

    render() {
      return createElement('WebView', this.props)
    }
  }
  return { WebView }
})

const alpha = { id: 'http://bridge.test:3080', url: 'http://bridge.test:3080/tasks', host: 'bridge.test', port: 3080 }
const beta = { id: 'https://second.test', url: 'https://second.test/workspaces', host: 'second.test', port: 443 }
const focus: NotificationFocus = { origin: 'http://bridge.test:3080', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha' }
const nonce = 'webview-uuid-1'
const failure = '连接失败，请检查主机地址、网络或访问令牌。'
const focusFailure = '已恢复连接，但未能定位通知对应会话，请在网页中手动选择。'
let screen: ReactTestRenderer | undefined
let store: typeof import('@/store/modules/connection')
let connection: typeof import('@/store/modules/connection').connection
let runtime: typeof import('@/store/modules/connection/runtime')
let BridgeWebView: typeof import('./webview').BridgeWebView
const pages: Array<Pick<EventTarget, 'dispatchEvent'>> = []

/** persist 插件在模块加载时就已经订阅 state，必须先复位插件元数据，否则下面的 `$patch` 会立刻写一次盘。 */
function resetConnection() {
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(store.createConnectionState())
  store.resetConnectionStorageCache()
  vi.clearAllMocks()
}

/** 与 restoreConnections() 等价的水合：快照进 state，hydrated 由 markHydrated 置位。 */
function hydrate() {
  connection.$patch(store.parseConnectionSnapshot({ version: 1, history: [], guidedHosts: [] }))
  connection.markHydrated({})
}

interface NativeViewRef {
  injectJavaScript: ReturnType<typeof vi.fn<(script: string) => void>>
  goBack: ReturnType<typeof vi.fn<() => void>>
}

function root() {
  if (!screen)
    throw new Error('Bridge WebView is not mounted')
  return screen.root
}

function webView() {
  return root().find(node => String(node.type) === 'WebView')
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string')
    return node
  return node.children.map(text).join('')
}

function texts() {
  return root().findAll(node => String(node.type) === 'Text').map(text)
}

async function viewRef(): Promise<NativeViewRef> {
  const { WebView } = await import('react-native-webview')
  return root().findByType(WebView).instance as NativeViewRef
}

async function mount() {
  await act(async () => {
    screen = create(createElement(BridgeWebView, { address: alpha, generation: connection.viewGeneration }))
  })
}

async function unmount() {
  await act(async () => {
    screen?.unmount()
  })
  screen = undefined
}

async function message(payload: unknown, options: { origin?: string, nonce?: string, url?: string, channel?: string } = {}) {
  await rawMessage(JSON.stringify({
    channel: options.channel ?? 'dsh-bridge',
    origin: options.origin ?? alpha.id,
    nonce: options.nonce ?? nonce,
    payload,
  }), options.url ?? alpha.url)
}

async function rawMessage(data: string, url = alpha.url) {
  await act(async () => {
    webView().props.onMessage({ nativeEvent: { data, url } })
  })
}

async function ready() {
  await message({ type: 'dsh://bridge-ready' })
}

async function changeAppState(state: string) {
  await act(async () => {
    native.appState.currentState = state
    for (const listener of native.appListeners)
      listener()
  })
}

function injectedMessages(view: NativeViewRef, options: { origin?: string, nonce?: string, topFrame?: boolean } = {}) {
  const messages: Record<string, unknown>[] = []
  const window = {
    top: null as unknown,
    __dshBridgeNonce: options.nonce ?? nonce,
    __dshBridgeReceive: (data: Record<string, unknown>) => messages.push(data),
  }
  window.top = options.topFrame === false ? {} : window
  const context = createVmContext({ window, location: { origin: options.origin ?? alpha.id } })
  for (const [script] of view.injectJavaScript.mock.calls)
    expect(runInContext(script, context, { timeout: 1000 })).toBe(true)
  return messages
}

class BrowserMessageEvent extends Event {
  readonly data: unknown
  readonly origin: string
  readonly source: unknown

  constructor(type: string, options: { data?: unknown, origin?: string, source?: unknown } = {}) {
    super(type)
    this.data = options.data
    this.origin = options.origin ?? ''
    this.source = options.source ?? null
  }
}

function createPage(selectSession?: (sessionId: string) => void, kind: 'app' | 'login' | 'unverified' = 'app') {
  const posts: string[] = []
  const events = new EventTarget()
  const documentEvents = new EventTarget()
  const window = {
    top: null as unknown,
    __DSH_BOOT__: kind === 'app' ? {} : undefined,
    __dshClientCtx: kind === 'app' ? { uiWorkspace: { openSession: selectSession } } : undefined,
    ReactNativeWebView: { postMessage: (raw: string) => posts.push(raw) },
    addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) => events.addEventListener(type, listener, options),
    removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions) => events.removeEventListener(type, listener, options),
    dispatchEvent: (event: Event) => events.dispatchEvent(event),
  }
  window.top = window
  pages.push(window)
  const styles = new Map<string, { id: string, textContent: string }>()
  const document = {
    hidden: false,
    readyState: 'complete',
    documentElement: { getAttribute: () => null },
    body: null,
    head: { appendChild: (style: { id: string, textContent: string }) => styles.set(style.id, style) },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: (id: string) => styles.get(id) ?? (kind === 'login' && id === 'loginForm' ? {} : null),
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) => documentEvents.addEventListener(type, listener, options),
    removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions) => documentEvents.removeEventListener(type, listener, options),
    dispatchEvent: (event: Event) => documentEvents.dispatchEvent(event),
  }
  class PageMutationObserver {
    observe = vi.fn()
    disconnect = vi.fn()
  }
  const context = createVmContext({ window, document, location: { origin: alpha.id }, MutationObserver: PageMutationObserver, Event, MessageEvent: BrowserMessageEvent, Date, setTimeout, clearTimeout })
  function run(script: string) {
    expect(runInContext(script, context, { timeout: 1000 })).toBe(true)
  }
  run(webView().props.injectedJavaScriptBeforeContentLoaded)
  return { posts, window, document, run }
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer')
      return
    originalError(...args)
  })
  native.appState.currentState = 'active'
  native.appListeners.clear()
  native.backListeners.clear()
  native.navigation.isFocused.mockReturnValue(true)
  let sequence = 0
  native.randomUUID.mockImplementation(() => `webview-uuid-${++sequence}`)
  native.openURL.mockResolvedValue(undefined)
  native.getPermissionsAsync.mockResolvedValue({ granted: true })
  native.requestPermissionsAsync.mockResolvedValue({ granted: true })
  native.setNotificationChannelAsync.mockResolvedValue(null)
  native.scheduleNotificationAsync.mockResolvedValue('notification-id')
  screen = undefined
  store = await import('@/store/modules/connection')
  connection = store.connection
  resetConnection()
  runtime = await import('@/store/modules/connection/runtime')
  ;({ BridgeWebView } = await import('./webview'))
  hydrate()
  runtime.connectAddress(alpha)
})

afterEach(async () => {
  for (const page of pages.splice(0))
    page.dispatchEvent(new Event('pagehide'))
  await unmount()
  runtime.stopConnectionRuntime()
  await vi.advanceTimersByTimeAsync(0)
  expect(native.appListeners.size).toBe(0)
  expect(native.backListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('rendered Bridge WebView document lifecycle', () => {
  it('never records Android native finish followed by network error as a successful connection', async () => {
    await mount()
    const view = await viewRef()
    await act(async () => {
      webView().props.onLoad({ nativeEvent: { url: alpha.url } })
    })

    expect(view.injectJavaScript).toHaveBeenCalledExactlyOnceWith(webView().props.injectedJavaScript)
    expect(connection.loading).toBe(true)
    expect(texts()).toContain('寻找可用连接')
    expect(connection.history).toEqual([])
    expect(connection.swipeHintVisible).toBe(false)
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    await act(async () => {
      webView().props.onError({ nativeEvent: { code: -2, description: 'net::ERR_NAME_NOT_RESOLVED' } })
    })
    await ready()

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBe(failure)
    expect(connection.health['http://bridge.test:3080']).toBe('unavailable')
    expect(connection.history).toEqual([])
    expect(connection.guidedHosts).toEqual([])
    expect(texts()).toContain(failure)
    expect(texts()).not.toContain('寻找可用连接')
    expect(texts()).not.toContain('向左滑查看连接信息')
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('accepts only a source-, origin-, channel- and nonce-authenticated ready envelope and records success once', async () => {
    await mount()
    for (const options of [
      { url: 'http://bridge.test:3081/tasks' },
      { url: 'https://bridge.test:3080/tasks' },
      { origin: 'http://bridge.test:3080/' },
      { origin: 'http://evil.test:3080' },
      { nonce: 'old-webview-nonce' },
      { channel: 'untrusted-channel' },
    ]) {
      await message({ type: 'dsh://bridge-ready' }, options)
      expect(connection.loading).toBe(true)
      expect(connection.history).toEqual([])
      expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    }
    await ready()

    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
    expect(texts()).toContain('向左滑查看连接信息')
    expect(texts()).not.toContain('寻找可用连接')
    const hint = root().find(node => node.props.accessibilityLabel === '关闭滑动引导')
    await act(async () => {
      hint.props.onPress()
      await vi.advanceTimersByTimeAsync(20001)
    })
    await ready()

    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(connection.guidedHosts).toEqual(['http://bridge.test:3080'])
    expect(connection.swipeHintVisible).toBe(false)
    expect(connection.loadError).toBeNull()
  })

  it.each(['before', 'after'] as const)('shows the verified DSH login document when Android reports its HTTP 401 %s readiness', async (order) => {
    await mount()
    const page = createPage(undefined, 'login')
    expect(page.posts.map(raw => JSON.parse(raw))).toEqual([{
      channel: 'dsh-bridge',
      origin: 'http://bridge.test:3080',
      nonce: 'webview-uuid-1',
      payload: { type: 'dsh://bridge-ready' },
    }])
    async function unauthorized() {
      await act(async () => {
        webView().props.onHttpError({ nativeEvent: { url: alpha.url, statusCode: 401 } })
      })
    }
    if (order === 'before')
      await unauthorized()
    await rawMessage(page.posts[0]!)
    if (order === 'after')
      await unauthorized()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loadError).toBeNull()
    expect(connection.loading).toBe(false)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(connection.health['http://bridge.test:3080']).toBe('available')
    expect(texts()).not.toContain(failure)
    expect(texts()).not.toContain('寻找可用连接')
  })

  it('does not accept an HTTP 401 document without a DSH login or application fingerprint', async () => {
    await mount()
    const page = createPage(undefined, 'unverified')
    await act(async () => {
      webView().props.onHttpError({ nativeEvent: { url: alpha.url, statusCode: 401 } })
    })
    expect(page.posts).toEqual([])
    expect(connection.loading).toBe(true)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBe(failure)
    expect(connection.history).toEqual([])
    expect(texts()).toContain(failure)
  })

  it('times out a later unverified HTTP 401 document without erasing earlier successful history', async () => {
    await mount()
    await ready()
    await act(async () => {
      connection.dismissHint()
      await vi.advanceTimersByTimeAsync(30000)
      webView().props.onLoadStart({ nativeEvent: { url: alpha.url, loading: true } })
    })
    const page = createPage(undefined, 'unverified')
    await act(async () => {
      webView().props.onHttpError({ nativeEvent: { url: alpha.url, statusCode: 401 } })
      await vi.advanceTimersByTimeAsync(19999)
    })
    expect(page.posts).toEqual([])
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(connection.loadError).toBe(failure)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(texts()).toContain(failure)
    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(1)
  })

  it('accepts a later verified HTTP 401 login document without its reload deadline firing', async () => {
    await mount()
    await ready()
    await act(async () => {
      connection.dismissHint()
      await vi.advanceTimersByTimeAsync(30000)
      webView().props.onLoadStart({ nativeEvent: { url: alpha.url, loading: true } })
    })
    const page = createPage(undefined, 'login')
    await act(async () => {
      webView().props.onHttpError({ nativeEvent: { url: alpha.url, statusCode: 401 } })
      await vi.advanceTimersByTimeAsync(19999)
    })
    await rawMessage(page.posts[0]!)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(texts()).not.toContain(failure)
    expect(texts()).not.toContain('寻找可用连接')
    expect(connection.swipeHintVisible).toBe(false)
  })

  it('recognizes a verified document on Android finish reinjection after the early shim saw no fingerprint', async () => {
    await mount()
    const page = createPage(undefined, 'unverified')
    const view = await viewRef()
    expect(page.posts).toEqual([])
    page.window.__DSH_BOOT__ = {}
    await act(async () => {
      webView().props.onLoad({ nativeEvent: { url: alpha.url } })
    })
    for (const [script] of view.injectJavaScript.mock.calls)
      page.run(script)
    expect(page.posts.map(raw => JSON.parse(raw))).toEqual([{
      channel: 'dsh-bridge',
      origin: 'http://bridge.test:3080',
      nonce: 'webview-uuid-1',
      payload: { type: 'dsh://bridge-ready' },
    }])
    await rawMessage(page.posts[0]!)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(texts()).not.toContain(failure)
  })

  it('gives a new trusted document its own full deadline while the previous document is not ready', async () => {
    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19000)
      webView().props.onLoadStart({ nativeEvent: { url: 'http://bridge.test:3080/login', loading: true } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(connection.loadError).toBeNull()
    expect(connection.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18999)
    })
    expect(connection.loadError).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(connection.loadError).toBe(failure)
    expect(connection.history).toEqual([])
    expect(texts()).toContain(failure)
  })

  it('accepts the verified replacement document after the previous document deadline has elapsed', async () => {
    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19000)
      webView().props.onLoadStart({ nativeEvent: { url: 'http://bridge.test:3080/login', loading: true } })
    })
    const page = createPage(undefined, 'login')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await rawMessage(page.posts[0]!, 'http://bridge.test:3080/login')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loadError).toBeNull()
    expect(connection.loading).toBe(false)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225621000 }])
    expect(texts()).not.toContain(failure)
  })

  it('keeps the one-shot ready document verified across Android same-document history and hash callbacks', async () => {
    connection.queueFocus(focus)
    await mount()
    const page = createPage()
    await rawMessage(page.posts[0]!)
    const view = await viewRef()
    view.injectJavaScript.mockClear()
    await act(async () => {
      connection.dismissHint()
      webView().props.onLoadStart({ nativeEvent: { url: 'http://bridge.test:3080/tasks?session=alpha', loading: false } })
      webView().props.onLoadStart({ nativeEvent: { url: 'http://bridge.test:3080/tasks?session=alpha#latest', loading: false } })
    })
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    expect(connection.pendingFocus).toEqual(focus)
    page.run(webView().props.injectedJavaScript)
    expect(page.posts).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })

    expect(connection.loadError).toBeNull()
    expect(connection.loading).toBe(false)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(connection.swipeHintVisible).toBe(false)
    expect(texts()).not.toContain(failure)
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true }, { url: 'http://bridge.test:3080/tasks?session=alpha#latest' })
    expect(connection.pendingFocus).toBeNull()
  })

  it('replaces a native-finished but unauthenticated document with a visible failure at exactly twenty seconds', async () => {
    await mount()
    await act(async () => {
      webView().props.onLoad({ nativeEvent: { url: alpha.url } })
      await vi.advanceTimersByTimeAsync(19999)
    })
    expect(connection.loading).toBe(true)
    expect(texts()).toContain('寻找可用连接')
    expect(texts()).not.toContain(failure)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBe(failure)
    expect(connection.history).toEqual([])
    expect(texts()).toContain(failure)
    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(0)
    expect(root().findAll(node => String(node.type) === 'Button').map(text)).toContain('重新连接')
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('ignores all retained lifecycle and message callbacks from a replaced WebView generation', async () => {
    await mount()
    const stale = webView().props
    const oldView = await viewRef()
    const newerFocus = { ...focus, origin: 'https://second.test', sessionId: 'session-new' }
    await act(async () => {
      runtime.connectAddress(beta)
      connection.queueFocus(newerFocus)
      screen!.update(createElement(BridgeWebView, { key: connection.viewGeneration, address: beta, generation: connection.viewGeneration }))
    })
    await act(async () => {
      for (const payload of [
        { type: 'dsh://bridge-ready' },
        { type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true },
        { type: 'dsh://native-notification', title: 'Stale answer', body: 'Old document', tag: 'old', sessionId: 'old' },
      ]) {
        stale.onMessage({ nativeEvent: { url: alpha.url, data: JSON.stringify({ channel: 'dsh-bridge', origin: alpha.id, nonce, payload }) } })
      }
      stale.onLoad({ nativeEvent: { url: alpha.url } })
      stale.onError({ nativeEvent: { code: -2 } })
      stale.onHttpError({ nativeEvent: { url: alpha.url, statusCode: 500 } })
      stale.onRenderProcessGone({ nativeEvent: { didCrash: true } })
      stale.onContentProcessDidTerminate({ nativeEvent: { url: alpha.url } })
    })

    expect(await viewRef()).not.toBe(oldView)
    expect(webView().props.source).toEqual({ uri: 'https://second.test/workspaces' })
    expect(connection.current).toEqual(beta)
    expect(connection.loading).toBe(true)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.pendingFocus).toEqual(newerFocus)
    expect(connection.notice).toBeNull()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
  })

  it('keeps earlier success history but rejects late ready and focus acknowledgment after a document error', async () => {
    connection.queueFocus(focus)
    await mount()
    await ready()
    const view = await viewRef()
    await act(async () => {
      webView().props.onError({ nativeEvent: { code: -6, description: 'net::ERR_CONNECTION_REFUSED' } })
    })
    const cancelled = injectedMessages(view)
    expect(cancelled).toContainEqual({ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' })
    view.injectJavaScript.mockClear()
    await ready()
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true })
    await changeAppState('background')
    await changeAppState('active')

    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(connection.loadError).toBe(failure)
    expect(connection.pendingFocus).toEqual(focus)
    expect(connection.swipeHintVisible).toBe(false)
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    expect(texts()).toContain(failure)
    expect(texts()).not.toContain('向左滑查看连接信息')
  })

  it('fails only HTTP errors for the tracked main document, not successful statuses or unrelated resources', async () => {
    await mount()
    await act(async () => {
      expect(webView().props.onShouldStartLoadWithRequest({ url: 'http://bridge.test:3080/sessions?selected=alpha' })).toBe(true)
      for (const nativeEvent of [
        { url: alpha.url, statusCode: 500 },
        { url: 'http://bridge.test:3080/assets/missing.js', statusCode: 404 },
        { url: 'http://foreign.test/error', statusCode: 503 },
        { url: 'http://bridge.test:3080/sessions?selected=alpha', statusCode: 399 },
      ])
        webView().props.onHttpError({ nativeEvent })
    })
    expect(connection.loading).toBe(true)
    expect(connection.loadError).toBeNull()
    await act(async () => {
      webView().props.onNavigationStateChange({ url: 'http://bridge.test:3080/login', canGoBack: true })
      webView().props.onHttpError({ nativeEvent: { url: 'http://bridge.test:3080/sessions?selected=alpha', statusCode: 500 } })
    })
    expect(connection.loadError).toBeNull()
    await act(async () => {
      webView().props.onHttpError({ nativeEvent: { url: 'http://bridge.test:3080/login', statusCode: 400 } })
    })

    expect(connection.loadError).toBe(failure)
    expect(connection.history).toEqual([])
    expect(texts()).toContain(failure)
  })

  it.each(['onRenderProcessGone', 'onContentProcessDidTerminate'])('shows a recoverable failure when native %s terminates the document', async (callback) => {
    await mount()
    await act(async () => {
      webView().props[callback]({ nativeEvent: { didCrash: true, url: alpha.url } })
    })

    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBe(failure)
    expect(connection.health['http://bridge.test:3080']).toBe('unavailable')
    expect(connection.history).toEqual([])
    expect(texts()).toContain(failure)
    expect(root().findAll(node => String(node.type) === 'Button').map(text)).toContain('重新连接')
  })
})

describe('rendered Bridge WebView verified native notification boundary', () => {
  const notification = { type: 'dsh://native-notification', title: '完成', body: '轮次已完成', sessionId: 'alpha', tag: 'dsh-notification-alpha-1', silent: false }

  it('does not schedule a same-origin notification before document readiness', async () => {
    native.appState.currentState = 'background'
    await mount()
    await message(notification)
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('does not schedule a late completion after a document fails', async () => {
    native.appState.currentState = 'background'
    await mount()
    await ready()
    await act(async () => {
      webView().props.onError({ nativeEvent: { code: -6 } })
    })
    await message(notification)
    expect(connection.loadError).toBe(failure)
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('delivers one verified background notification while rejecting foreign sources and stale nonces', async () => {
    native.appState.currentState = 'background'
    await mount()
    await ready()
    await message(notification, { nonce: 'stale-nonce' })
    await message(notification, { url: 'https://foreign.test/tasks' })
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
    await message(notification)
    expect(native.scheduleNotificationAsync).toHaveBeenCalledOnce()
    expect(native.scheduleNotificationAsync.mock.calls[0]?.[0]).toMatchObject({
      content: { title: '完成', body: '轮次已完成', data: { origin: 'http://bridge.test:3080', sessionId: 'alpha', tag: 'dsh-notification-alpha-1' } },
      trigger: { channelId: 'dsh-bridge' },
    })
  })
})

describe('rendered Bridge WebView foreground notification authorization', () => {
  it('requests native permission when a document first becomes active after background readiness', async () => {
    native.appState.currentState = 'background'
    native.getPermissionsAsync.mockResolvedValue({ granted: false })
    await mount()
    await ready()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
    await changeAppState('active')

    expect(native.setNotificationChannelAsync.mock.calls.map(call => call[0])).toEqual(['dsh-bridge', 'dsh-bridge-silent'])
    expect(native.getPermissionsAsync).toHaveBeenCalledExactlyOnceWith()
    expect(native.requestPermissionsAsync).toHaveBeenCalledExactlyOnceWith()
    const calls = [...native.setNotificationChannelAsync.mock.invocationCallOrder, ...native.getPermissionsAsync.mock.invocationCallOrder, ...native.requestPermissionsAsync.mock.invocationCallOrder]
    expect(calls).toEqual([...calls].sort((a, b) => a - b))
  })
})

describe('rendered Bridge WebView acknowledged notification focus', () => {
  it('keeps preexisting focus pending until the real injected page selects it and returns an authenticated matching acknowledgment', async () => {
    connection.queueFocus(focus)
    connection.setDrawerOpen(true)
    await mount()
    const view = await viewRef()
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    const selectSession = vi.fn<(sessionId: string) => void>()
    const page = createPage(selectSession)
    expect(JSON.parse(page.posts[0]!)).toEqual({ channel: 'dsh-bridge', origin: 'http://bridge.test:3080', nonce: 'webview-uuid-1', payload: { type: 'dsh://bridge-ready' } })
    await rawMessage(page.posts[0]!)

    expect(connection.pendingFocus).toEqual(focus)
    expect(connection.drawerOpen).toBe(false)
    expect(injectedMessages(view)).toEqual([
      { type: 'dsh://visibility-state', hidden: false, nonce: 'webview-uuid-1' },
      { type: 'dsh://focus-session', requestId: 'webview-uuid-2', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha', nonce: 'webview-uuid-1' },
    ])
    expect(injectedMessages(view, { origin: 'http://evil.test:3080' })).toEqual([])
    expect(injectedMessages(view, { nonce: 'old-view-nonce' })).toEqual([])
    expect(injectedMessages(view, { topFrame: false })).toEqual([])
    for (const [script] of view.injectJavaScript.mock.calls)
      page.run(script)
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('session-alpha')
    expect(connection.pendingFocus).toEqual(focus)
    expect(JSON.parse(page.posts[1]!)).toEqual({ channel: 'dsh-bridge', origin: 'http://bridge.test:3080', nonce: 'webview-uuid-1', payload: { type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true } })
    for (const options of [{ nonce: 'wrong-nonce' }, { origin: 'https://second.test' }, { url: 'http://bridge.test:3081/tasks' }]) {
      await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true }, options)
      expect(connection.pendingFocus).toEqual(focus)
    }
    await rawMessage(page.posts[1]!)

    expect(connection.pendingFocus).toBeNull()
    expect(connection.notice).toBeNull()
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' })
  })

  it('shows a visible manual-selection notice when the real page exhausts its fifteen-second focus budget', async () => {
    connection.queueFocus(focus)
    await mount()
    const view = await viewRef()
    const page = createPage()
    await rawMessage(page.posts[0]!)
    for (const [script] of view.injectJavaScript.mock.calls)
      page.run(script)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999)
    })
    expect(connection.pendingFocus).toEqual(focus)
    expect(connection.notice).toBeNull()
    expect(page.posts).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(JSON.parse(page.posts[1]!)).toEqual({ channel: 'dsh-bridge', origin: 'http://bridge.test:3080', nonce: 'webview-uuid-1', payload: { type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: false } })
    await rawMessage(page.posts[1]!)

    expect(connection.pendingFocus).toBeNull()
    expect(connection.notice).toBe(focusFailure)
    expect(texts()).toContain(focusFailure)
  })

  it('cancels superseded focus and cannot clear a newer pending session with an old or wrong request acknowledgment', async () => {
    connection.queueFocus(focus)
    await mount()
    await ready()
    const view = await viewRef()
    const newerFocus = { ...focus, sessionId: 'session-new', title: 'New answer', tag: 'tag-new' }
    await act(async () => {
      connection.queueFocus(newerFocus)
      webView().props.onMessage({ nativeEvent: { url: alpha.url, data: JSON.stringify({ channel: 'dsh-bridge', origin: alpha.id, nonce, payload: { type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: false } }) } })
    })
    expect(connection.pendingFocus).toEqual(newerFocus)
    expect(connection.notice).toBeNull()
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' })
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://focus-session', requestId: 'webview-uuid-3', sessionId: 'session-new', title: 'New answer', tag: 'tag-new', nonce: 'webview-uuid-1' })
    for (const requestId of ['webview-uuid-2', 'unknown-request']) {
      await message({ type: 'dsh://focus-result', requestId, handled: false })
      expect(connection.pendingFocus).toEqual(newerFocus)
      expect(connection.notice).toBeNull()
    }
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-3', handled: true })

    expect(connection.pendingFocus).toBeNull()
    expect(connection.notice).toBeNull()
  })

  it('assigns a fresh request when identical focus metadata is requeued so its earlier acknowledgment cannot clear the retry', async () => {
    connection.queueFocus(focus)
    await mount()
    await ready()
    const view = await viewRef()
    await act(async () => {
      connection.queueFocus({ ...focus })
    })
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' })
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://focus-session', requestId: 'webview-uuid-3', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha', nonce: 'webview-uuid-1' })
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true })
    expect(connection.pendingFocus).toEqual(focus)
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-3', handled: true })

    expect(connection.pendingFocus).toBeNull()
  })

  it('defers initial focus until authenticated foreground visibility and cancels/requeues it across background transitions', async () => {
    native.appState.currentState = 'background'
    connection.queueFocus(focus)
    await mount()
    const view = await viewRef()
    await changeAppState('active')
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    await changeAppState('background')
    await ready()
    expect(injectedMessages(view)).toEqual([{ type: 'dsh://visibility-state', hidden: true, nonce: 'webview-uuid-1' }])
    expect(connection.pendingFocus).toEqual(focus)
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    await changeAppState('active')
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://focus-session', requestId: 'webview-uuid-2', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha', nonce: 'webview-uuid-1' })
    await changeAppState('inactive')
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' })
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true })
    expect(connection.pendingFocus).toEqual(focus)
    await changeAppState('active')
    const messages = injectedMessages(view)
    expect(messages.filter(message => message.type === 'dsh://visibility-state')).toEqual([
      { type: 'dsh://visibility-state', hidden: true, nonce: 'webview-uuid-1' },
      { type: 'dsh://visibility-state', hidden: false, nonce: 'webview-uuid-1' },
      { type: 'dsh://visibility-state', hidden: true, nonce: 'webview-uuid-1' },
      { type: 'dsh://visibility-state', hidden: false, nonce: 'webview-uuid-1' },
    ])
    expect(messages.at(-1)).toEqual({ type: 'dsh://focus-session', requestId: 'webview-uuid-3', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha', nonce: 'webview-uuid-1' })
    expect(connection.pendingFocus).toEqual(focus)
  })

  it('resynchronizes background visibility when a trusted document reloads without an AppState change', async () => {
    native.appState.currentState = 'background'
    await mount()
    await ready()
    const view = await viewRef()
    view.injectJavaScript.mockClear()
    await act(async () => {
      webView().props.onLoadStart({ nativeEvent: { url: alpha.url, loading: true } })
    })
    await ready()

    expect(injectedMessages(view)).toEqual([{ type: 'dsh://visibility-state', hidden: true, nonce: 'webview-uuid-1' }])
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1767225600000 }])
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
  })

  it('cancels focus across login navigation and retries only after the new document is ready', async () => {
    connection.queueFocus(focus)
    await mount()
    await ready()
    const view = await viewRef()
    view.injectJavaScript.mockClear()
    await act(async () => {
      webView().props.onLoadStart({ nativeEvent: { url: 'http://bridge.test:3080/tasks', loading: true } })
      webView().props.onMessage({ nativeEvent: { url: alpha.url, data: JSON.stringify({ channel: 'dsh-bridge', origin: alpha.id, nonce, payload: { type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: true } }) } })
    })
    expect(connection.pendingFocus).toEqual(focus)
    expect(injectedMessages(view)).toEqual([{ type: 'dsh://cancel-focus', requestId: 'webview-uuid-2', nonce: 'webview-uuid-1' }])
    await ready()
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://visibility-state', hidden: false, nonce: 'webview-uuid-1' })
    expect(injectedMessages(view)).toContainEqual({ type: 'dsh://focus-session', requestId: 'webview-uuid-3', sessionId: 'session-alpha', title: 'Answer complete', tag: 'tag-alpha', nonce: 'webview-uuid-1' })
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-2', handled: false })
    expect(connection.pendingFocus).toEqual(focus)
    await message({ type: 'dsh://focus-result', requestId: 'webview-uuid-3', handled: true })
    expect(connection.pendingFocus).toBeNull()
  })

  it('does not send another origin pending focus into the ready page or close its open drawer', async () => {
    const foreignFocus = { ...focus, origin: 'https://second.test' }
    connection.queueFocus(foreignFocus)
    connection.setDrawerOpen(true)
    await mount()
    await ready()

    expect(injectedMessages(await viewRef())).toEqual([{ type: 'dsh://visibility-state', hidden: false, nonce: 'webview-uuid-1' }])
    expect(connection.pendingFocus).toEqual(foreignFocus)
    expect(connection.drawerOpen).toBe(true)
  })
})

describe('rendered Bridge WebView native navigation and resource boundaries', () => {
  it('treats missing Android isTopFrame as top-level and permits only exact-origin documents inside the WebView', async () => {
    await mount()
    await act(async () => {
      expect(webView().props.onShouldStartLoadWithRequest({ url: 'http://bridge.test:3080/session?id=alpha' })).toBe(true)
      expect(webView().props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
      expect(webView().props.onShouldStartLoadWithRequest({ url: 'https://foreign.test/embedded', isTopFrame: false })).toBe(true)
      for (const url of ['http://bridge.test:3081/tasks', 'https://bridge.test:3080/tasks', 'http://bridge.test.evil/tasks'])
        expect(webView().props.onShouldStartLoadWithRequest({ url })).toBe(false)
    })

    expect(native.openURL.mock.calls).toEqual([
      ['http://bridge.test:3081/tasks'],
      ['https://bridge.test:3080/tasks'],
      ['http://bridge.test.evil/tasks'],
    ])
    const view = await viewRef()
    await act(async () => {
      webView().props.onLoad({ nativeEvent: { url: 'https://foreign.test/embedded' } })
    })
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    expect(webView().props).toMatchObject({
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      mixedContentMode: 'never',
      thirdPartyCookiesEnabled: false,
      injectedJavaScriptForMainFrameOnly: true,
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
    })
  })

  it('opens only safe HTTP popup URLs externally and surfaces native Linking failures without executing custom schemes', async () => {
    await mount()
    await act(async () => {
      for (const targetUrl of ['javascript:alert(1)', 'file:///private/data', 'mailto:test@example.test', 'https://user:password@external.test/'])
        webView().props.onOpenWindow({ nativeEvent: { targetUrl } })
      webView().props.onOpenWindow({ nativeEvent: { targetUrl: 'https://external.test/help?q=bridge' } })
    })
    expect(native.openURL).toHaveBeenCalledExactlyOnceWith('https://external.test/help?q=bridge')
    expect(connection.notice).toBeNull()
    native.openURL.mockRejectedValueOnce(new Error('Native browser unavailable'))
    await act(async () => {
      webView().props.onOpenWindow({ nativeEvent: { targetUrl: 'http://external.test/unavailable' } })
    })

    expect(native.openURL).toHaveBeenLastCalledWith('http://external.test/unavailable')
    expect(connection.notice).toBe(failure)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([])
  })

  it('applies only authenticated page theme updates from the current verified document without remounting WebView', async () => {
    await mount()
    const view = await viewRef()
    await message({ type: 'dsh://theme-state', theme: 'light' })
    expect(native.setTheme).not.toHaveBeenCalled()
    await ready()
    for (const options of [
      { nonce: 'wrong' },
      { origin: 'http://foreign.test:3080' },
      { url: 'http://foreign.test:3080/' },
      { channel: 'other' },
    ]) {
      await message({ type: 'dsh://theme-state', theme: 'dark' }, options)
    }
    await message({ type: 'dsh://theme-state', theme: 'sepia' })
    expect(native.setTheme).not.toHaveBeenCalled()
    for (const theme of ['light', 'dark', 'system'])
      await message({ type: 'dsh://theme-state', theme })
    expect(native.setTheme.mock.calls).toEqual([['light'], ['dark'], ['system']])
    expect(await viewRef()).toBe(view)
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
    await act(async () => {
      webView().props.onLoadStart({ nativeEvent: { url: alpha.url, loading: true } })
    })
    await message({ type: 'dsh://theme-state', theme: 'light' })
    expect(native.setTheme).toHaveBeenCalledTimes(3)
    await ready()
    await act(async () => {
      webView().props.onError({ nativeEvent: { code: -2 } })
    })
    await message({ type: 'dsh://theme-state', theme: 'light' })
    expect(native.setTheme).toHaveBeenCalledTimes(3)
  })

  it('accepts the initial theme sent immediately after readiness before React commits state', async () => {
    await mount()
    await act(async () => {
      const receive = webView().props.onMessage
      for (const payload of [{ type: 'dsh://bridge-ready' }, { type: 'dsh://theme-state', theme: 'light' }]) {
        receive({ nativeEvent: {
          url: alpha.url,
          data: JSON.stringify({ channel: 'dsh-bridge', origin: alpha.id, nonce, payload }),
        } })
      }
    })
    expect(native.setTheme).toHaveBeenCalledExactlyOnceWith('light')
  })

  it('ignores theme messages from a replaced WebView generation', async () => {
    await mount()
    await ready()
    await act(async () => {
      connection.accept({ id: 'http://second.test:3080', url: 'http://second.test:3080', host: 'second.test', port: 3080 })
    })
    await message({ type: 'dsh://theme-state', theme: 'dark' })
    expect(native.setTheme).not.toHaveBeenCalled()
  })

  it('gives scanner focus and an open drawer first refusal before consuming Android back for WebView history', async () => {
    await mount()
    const view = await viewRef()
    expect(native.backListeners.size).toBe(1)
    const handler = [...native.backListeners][0]!
    expect(handler()).toBe(false)
    await act(async () => {
      webView().props.onNavigationStateChange({ url: alpha.url, canGoBack: true })
    })
    native.navigation.isFocused.mockReturnValue(false)
    expect(handler()).toBe(false)
    native.navigation.isFocused.mockReturnValue(true)
    await act(async () => {
      connection.setDrawerOpen(true)
    })
    expect(handler()).toBe(false)
    expect(view.goBack).not.toHaveBeenCalled()
    await act(async () => {
      connection.setDrawerOpen(false)
    })
    expect(handler()).toBe(true)
    expect(view.goBack).toHaveBeenCalledExactlyOnceWith()
    await act(async () => {
      webView().props.onNavigationStateChange({ url: alpha.url, canGoBack: false })
    })
    expect(handler()).toBe(false)
  })

  it('disposes native listeners, loader animations and the loading deadline so unmount cannot fail a later store state', async () => {
    await mount()
    const view = await viewRef()
    expect(native.appListeners.size).toBe(1)
    expect(native.backListeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await unmount()

    expect(native.appListeners.size).toBe(0)
    expect(native.backListeners.size).toBe(0)
    expect(native.cancelAnimation).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    connection.queueFocus(focus)
    await changeAppState('background')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20001)
    })
    expect(connection.loading).toBe(true)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.pendingFocus).toEqual(focus)
    expect(view.injectJavaScript).not.toHaveBeenCalled()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
  })
})
