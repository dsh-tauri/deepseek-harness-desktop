import type { NotificationResponse } from 'expo-notifications'
import type { ComponentType, ReactNode } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'
import { act, createElement } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// React Native 里 `window` 存在（就是全局对象），node 环境没有它会让 query-core 在模块加载时判定为 server 分支：
// `refetchInterval` 不再注册、`gcTime` 保持 Infinity。测试补一个最小客户端环境，让「前台轮询」按设备行为被验证。
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
  })
})

const native = vi.hoisted(() => ({
  path: '/',
  routes: {} as { home?: ComponentType, scan?: ComponentType },
  routeListeners: new Set<() => void>(),
  appState: { currentState: 'active' },
  appListeners: new Set<(state: string) => void>(),
  backListeners: new Set<() => boolean>(),
  responseListeners: new Set<(response: NotificationResponse) => void>(),
  navigation: { isFocused: vi.fn<() => boolean>() },
  push: vi.fn<(path: string) => void>(),
  back: vi.fn<() => void>(),
  dismissTo: vi.fn<(path: string) => void>(),
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  readToken: vi.fn<(key: string) => Promise<string | null>>(),
  writeToken: vi.fn<(key: string, value: string) => Promise<void>>(),
  deleteToken: vi.fn<(key: string) => Promise<void>>(),
  fetch: vi.fn<typeof fetch>(),
  getIpAddressAsync: vi.fn<() => Promise<string>>(),
  setNotificationHandler: vi.fn(),
  getLastNotificationResponseAsync: vi.fn<() => Promise<NotificationResponse | null>>(),
  clearLastNotificationResponseAsync: vi.fn<() => Promise<void>>(),
  getPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  requestPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  setNotificationChannelAsync: vi.fn<(...args: unknown[]) => Promise<null>>(),
  scheduleNotificationAsync: vi.fn<(...args: unknown[]) => Promise<string>>(),
  cancelAnimation: vi.fn(),
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: native.read, setItem: native.write } }))
vi.mock('expo-secure-store', () => ({ getItemAsync: native.readToken, setItemAsync: native.writeToken, deleteItemAsync: native.deleteToken }))
vi.mock('expo-network', () => ({ getIpAddressAsync: native.getIpAddressAsync }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'root-test-nonce' }))
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getPermissionsAsync: native.getPermissionsAsync,
  requestPermissionsAsync: native.requestPermissionsAsync,
  setNotificationChannelAsync: native.setNotificationChannelAsync,
  scheduleNotificationAsync: native.scheduleNotificationAsync,
  setNotificationHandler: native.setNotificationHandler,
  getLastNotificationResponseAsync: native.getLastNotificationResponseAsync,
  clearLastNotificationResponseAsync: native.clearLastNotificationResponseAsync,
  addNotificationResponseReceivedListener: (listener: (response: NotificationResponse) => void) => {
    native.responseListeners.add(listener)
    return { remove: () => {
      native.responseListeners.delete(listener)
    } }
  },
}))
vi.mock('expo-router', async () => {
  const { createElement, useSyncExternalStore } = await import('react')
  function subscribe(listener: () => void) {
    native.routeListeners.add(listener)
    return () => {
      native.routeListeners.delete(listener)
    }
  }
  function snapshot() {
    return native.path
  }
  function Stack(props: { children?: ReactNode }) {
    const path = useSyncExternalStore(subscribe, snapshot, snapshot)
    const { home: Home, scan: Scan } = native.routes
    if (!Home || !Scan)
      throw new Error('Production routes are not loaded')
    let modal: ReactNode = null
    if (path === '/scan')
      modal = createElement(Scan)
    return createElement('Stack', props, props.children, createElement(Home), modal)
  }
  return {
    router: { push: native.push, back: native.back, dismissTo: native.dismissTo },
    useNavigation: () => native.navigation,
    Stack: Object.assign(Stack, { Screen: 'Screen' }),
  }
})
vi.mock('uniwind', () => ({ Uniwind: { setTheme: vi.fn() } }))
// 文案与 store 现在都经过 i18n；node 环境无法真正加载 expo-localization（缺 __DEV__），设备区域固定为 zh-CN。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, vi.fn(async () => ({})), refreshCameraPermission],
}))
vi.mock('heroui-native/provider', () => ({ HeroUINativeProvider: 'HeroUINativeProvider' }))
vi.mock('heroui-native/hooks', () => ({
  useThemeColor: (names: string | string[]) => {
    if (Array.isArray(names))
      return names.map(() => '#ffffff')
    return '#ffffff'
  },
}))
vi.mock('heroui-native/button', async () => {
  const { createElement } = await import('react')
  function Button({ children, ...props }: { children?: ReactNode }) {
    return createElement('Button', props, children)
  }
  return { Button: Object.assign(Button, { Label: 'Text' }) }
})
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'GestureHandlerRootView' }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' }))
vi.mock('react-native-lucide', () => ({ History: 'Icon', Radar: 'Icon', ScanLine: 'Icon', RefreshCw: 'Icon', X: 'Icon', ArrowLeft: 'Icon', Hand: 'Icon' }))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'SvgPath', Rect: 'SvgRect', G: 'SvgGroup', Defs: 'SvgDefs', ClipPath: 'SvgClipPath' }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
  Linking: { openURL: vi.fn(async () => {}), openSettings: vi.fn(async () => {}) },
  useWindowDimensions: () => ({ width: 440, height: 900 }),
  AppState: {
    get currentState() { return native.appState.currentState },
    addEventListener: (_event: string, listener: (state: string) => void) => {
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
vi.mock('react-native-drawer-layout', async () => {
  const { createElement } = await import('react')
  function Drawer(props: { children?: ReactNode, open: boolean, renderDrawerContent: () => ReactNode }) {
    let content: ReactNode = null
    if (props.open)
      content = props.renderDrawerContent()
    return createElement('Drawer', props, props.children, content)
  }
  return { Drawer }
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

const alpha = { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks', host: 'bridge.local', port: 3080 }
const beta = { id: 'https://second.local', url: 'https://second.local/workspaces', host: 'second.local', port: 443 }
const snapshot = { version: 1 as const, history: [{ ...alpha, lastConnectedAt: 20 }, { ...beta, lastConnectedAt: 10 }], guidedHosts: ['http://bridge.local:3080', 'https://second.local'] }
let screen: ReactTestRenderer | undefined
let store: typeof import('@/store/modules/connection')
let connection: typeof import('@/store/modules/connection').connection
let runtime: typeof import('@/store/modules/connection/runtime')
let RootLayout: typeof import('@/app/_layout').default

/**
 * 统一复位契约：先清 persist 插件元数据（顺序反了 `$patch` 会触发一次写盘），再回到初始状态，
 * 最后清适配器的负载去重缓存，让「首次写入 / 重复写入」在每个用例里都可复现。
 */
function resetConnection() {
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(store.createConnectionState())
  store.resetConnectionStorageCache()
  vi.clearAllMocks()
}

/**
 * 与 `restoreConnections()` 等价的水合：快照经 `parseConnectionSnapshot` 进 state，
 * 令牌单独给出，`hydrated` 由 `markHydrated` 置位（也是 persist 插件开始写盘的前提）。
 */
function hydrate(data: unknown = { version: 1, history: [], guidedHosts: [] }, tokens: Record<string, string> = {}) {
  connection.$patch(store.parseConnectionSnapshot(data))
  connection.markHydrated(tokens)
}

async function refreshCameraPermission() {
  return { granted: true, canAskAgain: true }
}

function response(origin: string, sessionId: string): NotificationResponse {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      date: 1000,
      request: {
        identifier: `native-${sessionId}`,
        trigger: { channelId: 'dsh-bridge' },
        content: {
          title: 'Answer complete',
          subtitle: null,
          body: 'Ready',
          categoryIdentifier: null,
          sound: 'default',
          data: { origin, sessionId, title: 'Answer complete', tag: `tag-${sessionId}` },
        },
      },
    },
  }
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string')
    return node
  return node.children.map(text).join('')
}

function root() {
  if (!screen)
    throw new Error('Root layout is not mounted')
  return screen.root
}

function texts() {
  return root().findAll(node => String(node.type) === 'Text').map(text)
}

function button(label: string) {
  const buttons = root().findAll(node => String(node.type) === 'Button')
  const accessible = buttons.filter(node => node.props.accessibilityLabel === label)
  const matches = accessible.length ? accessible : buttons.filter(node => text(node) === label)
  expect(matches, `Button ${label}`).toHaveLength(1)
  return matches[0]!
}

function drawer() {
  return root().find(node => String(node.type) === 'Drawer')
}

function webView() {
  const views = root().findAll(node => String(node.type) === 'WebView')
  expect(views).toHaveLength(1)
  return views[0]!
}

async function webViewInstance() {
  const { WebView } = await import('react-native-webview')
  return root().findByType(WebView).instance as { injectJavaScript: ReturnType<typeof vi.fn<(script: string) => void>> }
}

function navigate(path: string) {
  native.path = path
  for (const listener of native.routeListeners)
    listener()
}

async function press(label: string) {
  await act(async () => {
    await button(label).props.onPress()
  })
}

async function mount() {
  await act(async () => {
    screen = create(createElement(RootLayout))
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function unmount() {
  await act(async () => {
    screen?.unmount()
    await vi.advanceTimersByTimeAsync(0)
  })
  screen = undefined
}

/** 卸载后残留的定时器只可能属于 React Query 的查询缓存回收，清掉查询缓存后再断言没有遗留定时器。 */
async function dropQueries() {
  const { queryClient } = await import('@/config/client')
  queryClient.clear()
}

async function emitResponse(click: NotificationResponse) {
  await act(async () => {
    for (const listener of native.responseListeners)
      listener(click)
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function changeAppState(state: string) {
  await act(async () => {
    native.appState.currentState = state
    for (const listener of native.appListeners)
      listener(state)
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function ready(origin: string) {
  await act(async () => {
    webView().props.onMessage({
      nativeEvent: {
        url: webView().props.source.uri,
        data: JSON.stringify({ channel: 'dsh-bridge', origin, nonce: 'root-test-nonce', payload: { type: 'dsh://bridge-ready' } }),
      },
    })
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function focusResult(origin: string) {
  await act(async () => {
    webView().props.onMessage({
      nativeEvent: {
        url: webView().props.source.uri,
        data: JSON.stringify({ channel: 'dsh-bridge', origin, nonce: 'root-test-nonce', payload: { type: 'dsh://focus-result', requestId: 'root-test-nonce', handled: true } }),
      },
    })
    await vi.advanceTimersByTimeAsync(0)
  })
}

function holdNetwork() {
  native.fetch.mockImplementation((_input, options) => new Promise<Response>((resolve) => {
    const signal = options?.signal
    if (!signal)
      throw new Error('Expected an abortable network request')
    signal.addEventListener('abort', () => resolve(new Response(null, { status: 503 })), { once: true })
  }))
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
  native.path = '/'
  native.routes = {}
  native.routeListeners.clear()
  native.appState.currentState = 'active'
  native.appListeners.clear()
  native.backListeners.clear()
  native.responseListeners.clear()
  native.navigation.isFocused.mockImplementation(() => native.path === '/')
  native.push.mockImplementation(navigate)
  native.back.mockImplementation(() => navigate('/'))
  native.dismissTo.mockImplementation(navigate)
  native.read.mockResolvedValue(null)
  native.write.mockResolvedValue(undefined)
  native.readToken.mockResolvedValue(null)
  native.writeToken.mockResolvedValue(undefined)
  native.deleteToken.mockResolvedValue(undefined)
  native.fetch.mockImplementation(async () => Response.json({ enabled: false, allowLoopback: true }))
  native.getIpAddressAsync.mockResolvedValue('0.0.0.0')
  native.getLastNotificationResponseAsync.mockResolvedValue(null)
  native.clearLastNotificationResponseAsync.mockResolvedValue(undefined)
  native.getPermissionsAsync.mockResolvedValue({ granted: true })
  native.requestPermissionsAsync.mockResolvedValue({ granted: true })
  native.setNotificationChannelAsync.mockResolvedValue(null)
  native.scheduleNotificationAsync.mockResolvedValue('notification-id')
  vi.stubGlobal('fetch', native.fetch)
  screen = undefined
  store = await import('@/store/modules/connection')
  connection = store.connection
  runtime = await import('@/store/modules/connection/runtime')
  resetConnection()
  native.routes.home = (await import('@/app/index')).default
  native.routes.scan = (await import('@/app/scan')).default
  ;({ default: RootLayout } = await import('@/app/_layout'))
})

afterEach(async () => {
  await unmount()
  runtime.stopConnectionRuntime()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(native.appListeners.size).toBe(0)
  expect(native.backListeners.size).toBe(0)
  expect(native.responseListeners.size).toBe(0)
  expect(native.routeListeners.size).toBe(0)
})

describe('rendered root hydration', () => {
  it('waits for history and secure tokens before discovery or persistence and declares the QR modal route', async () => {
    const historyRead = Promise.withResolvers<string | null>()
    const tokenRead = Promise.withResolvers<string | null>()
    native.read.mockReturnValue(historyRead.promise)
    native.readToken.mockReturnValue(tokenRead.promise)
    await mount()
    expect(root().findAll(node => String(node.type) === 'Screen').map(node => node.props)).toEqual([
      { name: 'index' },
      { name: 'scan', options: { presentation: 'fullScreenModal' } },
    ])
    expect(drawer().props.swipeEnabled).toBe(false)
    for (const label of ['自动扫描局域网', '扫码连接', '最近连接'])
      expect(button(label).props.isDisabled).toBe(true)
    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()

    await act(async () => {
      historyRead.resolve(JSON.stringify({ version: 1, history: [{ ...alpha, lastConnectedAt: 20 }], guidedHosts: [] }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(native.readToken).toHaveBeenCalledTimes(1)
    expect(connection.hydrated).toBe(false)
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()
    await act(async () => {
      tokenRead.resolve('secure-token')
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(drawer().props.swipeEnabled).toBe(true)
    expect(webView().props.source).toEqual({ uri: 'http://bridge.local:3080/tasks?auth=secure-token' })
    expect(texts()).toContain('寻找可用连接')
    expect(native.read).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections')
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    // 磁盘上已是与快照等价的负载，适配器去重后水合本身不写盘（旧实现「持久化字段未变不写盘」的等价断言）。
    expect(native.write).not.toHaveBeenCalled()
    // 只有持久化字段真的变化（会话落库）才写盘，且负载永远不含令牌。
    await act(async () => {
      runtime.connectAddress(alpha)
      connection.markLoaded(connection.viewGeneration, 30)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(native.write.mock.calls.length).toBeGreaterThan(0)
    for (const [key, payload] of native.write.mock.calls) {
      expect(key).toBe('dsh-bridge/connections')
      expect(JSON.parse(payload)).toEqual({ version: 1, history: [{ ...alpha, lastConnectedAt: 30 }], guidedHosts: [] })
      expect(payload).not.toContain('secure-token')
    }
  })
})

describe('rendered root entry selection', () => {
  it('offers connection methods on a first launch without probing or automatically scanning the LAN', async () => {
    native.getIpAddressAsync.mockResolvedValue('192.168.1.50')
    await mount()

    expect(connection.hydrated).toBe(true)
    expect(connection.stage).toBe('idle')
    expect(connection.current).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.notice).toBeNull()
    expect(root().findAll(node => String(node.type) === 'WebView')).toHaveLength(0)
    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(0)
    for (const label of ['自动扫描局域网', '扫码连接', '最近连接'])
      expect(button(label).props.isDisabled).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    await changeAppState('background')
    await changeAppState('active')
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('does not treat an unsupported or invalid stored history as permission to scan automatically', async () => {
    native.read.mockResolvedValue(JSON.stringify({ version: 2, history: [{ ...alpha, lastConnectedAt: 20 }], guidedHosts: [] }))
    await mount()

    expect(connection.history).toEqual([])
    expect(connection.stage).toBe('idle')
    expect(button('自动扫描局域网').props.isDisabled).toBe(false)
    expect(native.readToken).not.toHaveBeenCalled()
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
  })

  it('automatically searches saved history on re-entry and connects the available older entry without a LAN scan', async () => {
    native.read.mockResolvedValue(JSON.stringify(snapshot))
    const newest = Promise.withResolvers<Response>()
    const older = Promise.withResolvers<Response>()
    native.fetch.mockImplementation((input) => {
      if (String(input).startsWith('http://bridge.local:3080/'))
        return newest.promise
      return older.promise
    })
    await mount()

    expect(connection.stage).toBe('scanning')
    expect(texts()).toContain('寻找可用连接')
    // 只锁定探测到的主机集合与顺序：水合后的健康查询与历史自动接入各探一轮，重复轮次不是本用例的契约。
    expect([...new Set(native.fetch.mock.calls.map(([url]) => url))]).toEqual([
      'http://bridge.local:3080/__dsh_bridge__/auth-status',
      'https://second.local/__dsh_bridge__/auth-status',
    ])
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    await act(async () => {
      older.resolve(Response.json({ enabled: false, allowLoopback: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(connection.current).toBeNull()
    await act(async () => {
      newest.resolve(new Response(null, { status: 503 }))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(connection.current).toEqual(beta)
    expect(webView().props.source).toEqual({ uri: 'https://second.local/workspaces' })
    expect(texts()).toContain('寻找可用连接')
    expect(connection.history).toEqual(snapshot.history)
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    await ready('https://second.local')
    expect(texts()).not.toContain('寻找可用连接')
  })

  it('returns to method selection when all saved connections are unavailable instead of scanning the LAN', async () => {
    native.read.mockResolvedValue(JSON.stringify(snapshot))
    native.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    await mount()

    expect(connection.stage).toBe('idle')
    expect(connection.current).toBeNull()
    expect(connection.history).toEqual(snapshot.history)
    expect(connection.health).toEqual({ 'http://bridge.local:3080': 'unavailable', 'https://second.local': 'unavailable' })
    expect(texts()).toContain('未找到可用的历史连接，请选择连接方式。')
    expect(root().findAll(node => String(node.type) === 'WebView')).toHaveLength(0)
    for (const label of ['自动扫描局域网', '扫码连接', '最近连接'])
      expect(button(label).props.isDisabled).toBe(false)
    // 每个已保存主机都被探测过（健康查询与历史自动接入各一轮，故这里只锁定去重后的主机数）。
    expect(new Set(native.fetch.mock.calls.map(([url]) => url)).size).toBe(2)
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('lets the user cancel history reconnection and open QR without a late result replacing the selection', async () => {
    native.read.mockResolvedValue(JSON.stringify(snapshot))
    holdNetwork()
    await mount()
    expect(texts()).toContain('寻找可用连接')
    const signals = native.fetch.mock.calls.map(([, options]) => options!.signal!)

    await press('取消')
    // 取消中止的是历史自动接入那一轮探测（每个已保存主机一个）；健康查询的探测由 React Query 自己管理。
    expect(signals.filter(signal => signal.aborted)).toHaveLength(2)
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBeNull()
    await press('扫码连接')
    expect(texts()).toContain('扫码连接 DSH Bridge')
    expect(connection.current).toBeNull()
    expect(connection.history).toEqual(snapshot.history)
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
  })
})

describe('rendered root notification focus', () => {
  it('holds a cold notification until hydration completes, then returns from QR to the saved host and delivers focus after readiness', async () => {
    const historyRead = Promise.withResolvers<string | null>()
    const tokenRead = Promise.withResolvers<string | null>()
    native.read.mockReturnValue(historyRead.promise)
    native.readToken.mockReturnValue(tokenRead.promise)
    native.getLastNotificationResponseAsync.mockResolvedValue(response('http://bridge.local:3080', 'cold-session'))
    native.path = '/scan'
    await mount()
    expect(texts()).toContain('扫码连接 DSH Bridge')
    expect(connection.pendingFocus).toEqual({ origin: 'http://bridge.local:3080', sessionId: 'cold-session', title: 'Answer complete', tag: 'tag-cold-session' })
    expect(native.dismissTo).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()

    await act(async () => {
      historyRead.resolve(JSON.stringify({ version: 1, history: [{ ...alpha, lastConnectedAt: 20 }], guidedHosts: [] }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(native.dismissTo).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
    await act(async () => {
      tokenRead.resolve('cold-secret')
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(native.dismissTo).toHaveBeenCalledWith('/')
    expect(texts()).not.toContain('扫码连接 DSH Bridge')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(drawer().props.open).toBe(false)
    expect(webView().props.source).toEqual({ uri: 'http://bridge.local:3080/tasks?auth=cold-secret' })
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(connection.pendingFocus?.sessionId).toBe('cold-session')
    const instance = await webViewInstance()
    await ready('http://bridge.local:3080')
    expect(connection.pendingFocus?.sessionId).toBe('cold-session')
    expect(texts()).not.toContain('寻找可用连接')
    expect(instance.injectJavaScript.mock.calls.map(([script]) => script).join('\n')).toContain('"type":"dsh://focus-session","requestId":"root-test-nonce","sessionId":"cold-session","title":"Answer complete","tag":"tag-cold-session"')
    await focusResult('http://bridge.local:3080')
    expect(connection.pendingFocus).toBeNull()
    expect(texts()).not.toContain('已恢复连接，但未能定位通知对应会话，请在网页中手动选择。')
  })

  it('routes a warm notification for another saved host out of the scanner and waits for that host to become ready', async () => {
    hydrate(snapshot, { 'http://bridge.local:3080': 'saved-secret' })
    runtime.connectAddress(beta)
    await mount()
    await ready('https://second.local')
    await act(async () => {
      drawer().props.onOpen()
    })
    await press('扫码连接')
    expect(texts()).toContain('扫码连接 DSH Bridge')
    const oldInstance = await webViewInstance()

    await emitResponse(response('http://bridge.local:3080', 'warm-session'))

    expect(native.dismissTo).toHaveBeenCalledExactlyOnceWith('/')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(texts()).not.toContain('扫码连接 DSH Bridge')
    expect(webView().props.source).toEqual({ uri: 'http://bridge.local:3080/tasks?auth=saved-secret' })
    expect(await webViewInstance()).not.toBe(oldInstance)
    expect(texts()).toContain('寻找可用连接')
    expect(connection.pendingFocus?.sessionId).toBe('warm-session')
    const newInstance = await webViewInstance()
    await ready('http://bridge.local:3080')
    expect(connection.pendingFocus?.sessionId).toBe('warm-session')
    expect(texts()).not.toContain('寻找可用连接')
    expect(newInstance.injectJavaScript.mock.calls.map(([script]) => script).join('\n')).toContain('"type":"dsh://focus-session","requestId":"root-test-nonce","sessionId":"warm-session","title":"Answer complete","tag":"tag-warm-session"')
    await focusResult('http://bridge.local:3080')
    expect(connection.pendingFocus).toBeNull()
    expect(native.read).not.toHaveBeenCalled()
  })

  it('dismisses a hydrated same-origin QR modal without reconnecting the already loaded WebView', async () => {
    hydrate(snapshot, { 'http://bridge.local:3080': 'saved-secret' })
    runtime.connectAddress(alpha)
    await mount()
    await ready('http://bridge.local:3080')
    const instance = await webViewInstance()
    const generation = connection.viewGeneration
    await act(async () => {
      drawer().props.onOpen()
    })
    await press('扫码连接')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(1)

    await emitResponse(response('http://bridge.local:3080', 'same-session'))

    expect(native.dismissTo).toHaveBeenCalledExactlyOnceWith('/')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(texts()).not.toContain('扫码连接 DSH Bridge')
    expect(texts()).not.toContain('寻找可用连接')
    expect(drawer().props.open).toBe(false)
    expect(await webViewInstance()).toBe(instance)
    expect(connection.viewGeneration).toBe(generation)
    expect(connection.pendingFocus?.sessionId).toBe('same-session')
    expect(instance.injectJavaScript.mock.calls.map(([script]) => script).join('\n')).toContain('"type":"dsh://focus-session","requestId":"root-test-nonce","sessionId":"same-session","title":"Answer complete","tag":"tag-same-session"')
    await focusResult('http://bridge.local:3080')
    expect(connection.pendingFocus).toBeNull()
    expect(await webViewInstance()).toBe(instance)
  })

  it('uses a same-origin current connection not yet in history to restore a pending focus at root mount', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    connection.queueFocus({ origin: 'http://bridge.local:3080', sessionId: 'pending-session', title: 'Answer complete', tag: 'tag-pending-session' })
    connection.setDrawerOpen(true)
    native.path = '/scan'

    await mount()

    expect(native.dismissTo).toHaveBeenCalledWith('/')
    expect(drawer().props.open).toBe(false)
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(connection.viewGeneration).toBe(1)
    expect(connection.history).toEqual([])
    expect(webView().props.source).toEqual({ uri: 'http://bridge.local:3080/tasks' })
    expect(connection.pendingFocus?.sessionId).toBe('pending-session')
    const instance = await webViewInstance()
    await ready('http://bridge.local:3080')
    expect(connection.pendingFocus?.sessionId).toBe('pending-session')
    expect(instance.injectJavaScript.mock.calls.map(([script]) => script).join('\n')).toContain('"type":"dsh://focus-session","requestId":"root-test-nonce","sessionId":"pending-session","title":"Answer complete","tag":"tag-pending-session"')
    await focusResult('http://bridge.local:3080')
    expect(connection.pendingFocus).toBeNull()
  })

  it('clears an unknown-origin notification without dismissing QR or replacing the visible connection', async () => {
    hydrate(snapshot)
    runtime.connectAddress(beta)
    native.path = '/scan'
    await mount()
    const instance = await webViewInstance()

    await emitResponse(response('https://unknown.local', 'unknown-session'))

    expect(connection.pendingFocus).toBeNull()
    expect(native.dismissTo).not.toHaveBeenCalled()
    expect(texts()).toContain('扫码连接 DSH Bridge')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(1)
    expect(webView().props.source).toEqual({ uri: 'https://second.local/workspaces' })
    expect(await webViewInstance()).toBe(instance)
    expect(connection.history.map(entry => entry.id)).toEqual(['http://bridge.local:3080', 'https://second.local'])
  })
})

describe('rendered root lifecycle resources', () => {
  it('refreshes health on foreground return and active intervals, but not while backgrounded', async () => {
    // 客户端环境由文件顶部的 `vi.hoisted` 提供：`isServer` 在 query-core 模块加载时就已确定，
    // 测试内再补 `window` 不会生效，只会掩盖「前台按间隔轮询」这条设备行为。
    hydrate({ version: 1, history: [{ ...alpha, lastConnectedAt: 20 }], guidedHosts: ['http://bridge.local:3080'] })
    runtime.connectAddress(alpha)
    await mount()
    await ready('http://bridge.local:3080')
    await act(async () => {
      drawer().props.onOpen()
    })
    native.fetch.mockClear()

    await changeAppState('background')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(native.fetch).not.toHaveBeenCalled()
    native.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    await changeAppState('active')
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(texts()).toContain('主机暂时不可用')
    expect(button('bridge.local:3080，不可用').props.accessibilityLabel).toBe('bridge.local:3080，不可用')
    native.fetch.mockClear()
    native.fetch.mockImplementation(async () => Response.json({ enabled: false, allowLoopback: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(texts()).not.toContain('主机暂时不可用')
    expect(button('bridge.local:3080，可用').props.accessibilityLabel).toBe('bridge.local:3080，可用')
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
  })

  it('does not acquire persistence, discovery or focus work when unmounted before hydration resolves', async () => {
    const historyRead = Promise.withResolvers<string | null>()
    const coldResponse = Promise.withResolvers<NotificationResponse | null>()
    native.read.mockReturnValue(historyRead.promise)
    native.getLastNotificationResponseAsync.mockReturnValue(coldResponse.promise)
    native.readToken.mockResolvedValue('late-token')
    await mount()
    expect(connection.hydrated).toBe(false)

    await unmount()
    historyRead.resolve(JSON.stringify({ version: 1, history: [{ ...alpha, lastConnectedAt: 20 }], guidedHosts: [] }))
    coldResponse.resolve(response('http://bridge.local:3080', 'late-session'))
    await vi.advanceTimersByTimeAsync(0)

    expect(connection.hydrated).toBe(true)
    expect(connection.pendingFocus).toBeNull()
    expect(native.getIpAddressAsync).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.dismissTo).not.toHaveBeenCalled()
    expect(native.setNotificationHandler).toHaveBeenLastCalledWith(null)
    // 卸载后残留的定时器只可能属于 React Query 的查询缓存回收，清掉查询缓存后再断言没有遗留定时器。
    await dropQueries()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts active discovery and disposes native subscriptions, persistence, focus and health timers on unmount', async () => {
    native.getIpAddressAsync.mockResolvedValue('192.168.1.50')
    holdNetwork()
    await mount()
    expect(native.fetch).not.toHaveBeenCalled()
    await press('自动扫描局域网')
    expect(texts()).toContain('扫描局域网端口中...')
    expect(native.fetch.mock.calls.length).toBeGreaterThan(0)
    const signals = native.fetch.mock.calls.map(([, options]) => options!.signal!)
    const listener = [...native.responseListeners][0]!

    await unmount()

    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(native.setNotificationHandler).toHaveBeenLastCalledWith(null)
    // 卸载后残留的定时器只可能属于 React Query 的查询缓存回收，清掉查询缓存后再断言没有遗留定时器。
    await dropQueries()
    expect(vi.getTimerCount()).toBe(0)
    expect(native.appListeners.size).toBe(0)
    expect(native.backListeners.size).toBe(0)
    expect(native.responseListeners.size).toBe(0)
    expect(native.routeListeners.size).toBe(0)
    native.write.mockClear()
    native.writeToken.mockClear()
    native.fetch.mockClear()
    listener(response('http://bridge.local:3080', 'disposed-session'))
    expect(connection.pendingFocus).toBeNull()
    runtime.connectAddress({ ...alpha, token: 'after-unmount' })
    connection.markLoaded(connection.viewGeneration, 40)
    connection.queueFocus({ origin: 'http://bridge.local:3080', sessionId: 'unobserved', title: '', tag: '' })
    await vi.advanceTimersByTimeAsync(15000)
    // 快照落盘归 persist 插件所有（进程级订阅，不随布局卸载释放），布局自己持有的只有 SecureStore 令牌订阅。
    expect(native.write.mock.calls.map(([, payload]) => JSON.parse(payload))).toEqual([
      { version: 1, history: [{ ...alpha, lastConnectedAt: 40 }], guidedHosts: [] },
    ])
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
    expect(native.dismissTo).not.toHaveBeenCalled()
  })
})
