import type { ReactNode } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'
import type { HistoryEntry } from '@/store/modules/connection'
import { act, createElement } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  appState: { currentState: 'active' },
  appListeners: new Set<() => void>(),
  backListeners: new Set<() => boolean>(),
  navigation: { isFocused: vi.fn<() => boolean>() },
  push: vi.fn<(path: string) => void>(),
  fetch: vi.fn<typeof fetch>(),
  getIpAddressAsync: vi.fn<() => Promise<string>>(),
  getPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  requestPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(),
  setNotificationChannelAsync: vi.fn<(...args: unknown[]) => Promise<null>>(),
  scheduleNotificationAsync: vi.fn<(...args: unknown[]) => Promise<string>>(),
  cancelAnimation: vi.fn(),
  dimensions: { width: 440, height: 900 },
  theme: { 'background': '#ffffff', 'foreground': '#0f1115', 'accent-foreground': '#ffffff' } as Record<string, string>,
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
  Linking: { openURL: vi.fn(async () => {}) },
  useWindowDimensions: () => native.dimensions,
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
vi.mock('uniwind', () => ({ Uniwind: { setTheme: vi.fn() } }))
// 文案与 store 现在都经过 i18n；node 环境无法真正加载 expo-localization（缺 __DEV__），设备区域固定为 zh-CN。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
// store 模块经 valtio-define persist 插件依赖 AsyncStorage，node 环境用最小实现顶替。
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }))
vi.mock('expo-router', () => ({ router: { push: native.push }, useNavigation: () => native.navigation }))
vi.mock('expo-network', () => ({ getIpAddressAsync: native.getIpAddressAsync }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'home-test-nonce' }))
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
  getPermissionsAsync: native.getPermissionsAsync,
  requestPermissionsAsync: native.requestPermissionsAsync,
  setNotificationChannelAsync: native.setNotificationChannelAsync,
  scheduleNotificationAsync: native.scheduleNotificationAsync,
}))
vi.mock('heroui-native/hooks', () => ({
  useThemeColor: (names: string | string[]) => {
    if (Array.isArray(names))
      return names.map(name => native.theme[name] ?? '#ffffff')
    return native.theme[names] ?? '#ffffff'
  },
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'SvgPath', Rect: 'SvgRect', G: 'SvgGroup', Defs: 'SvgDefs', ClipPath: 'SvgClipPath' }))
vi.mock('heroui-native/button', async () => {
  const { createElement } = await import('react')
  function Button({ children, ...props }: { children?: ReactNode }) {
    return createElement('Button', props, children)
  }
  return { Button: Object.assign(Button, { Label: 'Text' }) }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('react-native-lucide', () => ({ History: 'HistoryIcon', Radar: 'RadarIcon', QrCode: 'QrCodeIcon', ScanLine: 'ScanLineIcon', RefreshCw: 'RefreshIcon', X: 'Icon', ArrowLeft: 'Icon', Hand: 'Icon' }))
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

const alpha = { id: 'http://one.local:3080', url: 'http://one.local:3080/tasks', host: 'one.local', port: 3080 }
const history: HistoryEntry[] = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((name, index) => ({
  id: `http://${name}.local:3080`,
  url: `http://${name}.local:3080/tasks`,
  host: `${name}.local`,
  port: 3080,
  lastConnectedAt: 70 - index * 10,
}))
let screen: ReactTestRenderer | undefined
let store: typeof import('@/store/modules/connection')
let connection: typeof import('@/store/modules/connection').connection
let runtime: typeof import('@/store/modules/connection/runtime')
let HomeScreen: typeof import('@/app/index').default

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string')
    return node
  return node.children.map(text).join('')
}

function root() {
  if (!screen)
    throw new Error('Home screen is not mounted')
  return screen.root
}

function button(label: string) {
  const buttons = root().findAll(node => String(node.type) === 'Button')
  const accessible = buttons.filter(node => node.props.accessibilityLabel === label)
  const matches = accessible.length ? accessible : buttons.filter(node => text(node) === label)
  expect(matches, `Button ${label}`).toHaveLength(1)
  return matches[0]!
}

function texts() {
  return root().findAll(node => String(node.type) === 'Text').map(text)
}

function drawer() {
  return root().find(node => String(node.type) === 'Drawer')
}

function webView() {
  return root().find(node => String(node.type) === 'WebView')
}

async function press(label: string) {
  const target = button(label)
  expect(target.props.isDisabled).not.toBe(true)
  await act(async () => {
    await target.props.onPress()
  })
}

async function mount() {
  await act(async () => {
    screen = create(createElement(HomeScreen))
  })
}

/** persist 插件在模块加载时就已经订阅 state，必须先复位插件元数据，否则下面的 `$patch` 会立刻写一次盘。 */
function resetConnection() {
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(store.createConnectionState())
  store.resetConnectionStorageCache()
  vi.clearAllMocks()
}

function hydrate(entries: HistoryEntry[] = []) {
  connection.$patch(store.parseConnectionSnapshot({ version: 1, history: entries, guidedHosts: [] }))
  connection.markHydrated({ 'http://one.local:3080': 'saved-token' })
}

function holdNetwork() {
  native.fetch.mockImplementation((_input, options) => new Promise<Response>((resolve) => {
    const signal = options?.signal
    if (!signal)
      throw new Error('Expected an abortable network request')
    signal.addEventListener('abort', () => resolve(new Response(null, { status: 503 })), { once: true })
  }))
}

async function ready() {
  await act(async () => {
    webView().props.onMessage({
      nativeEvent: {
        url: 'http://one.local:3080/tasks?auth=saved-token',
        data: JSON.stringify({ channel: 'dsh-bridge', origin: 'http://one.local:3080', nonce: 'home-test-nonce', payload: { type: 'dsh://bridge-ready' } }),
      },
    })
  })
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
  native.dimensions = { width: 440, height: 900 }
  native.theme = { 'background': '#ffffff', 'foreground': '#0f1115', 'accent-foreground': '#ffffff' }
  native.appListeners.clear()
  native.backListeners.clear()
  native.navigation.isFocused.mockReturnValue(true)
  native.fetch.mockImplementation(async () => Response.json({ enabled: false, allowLoopback: true }))
  native.getIpAddressAsync.mockResolvedValue('192.168.1.50')
  native.getPermissionsAsync.mockResolvedValue({ granted: true })
  native.requestPermissionsAsync.mockResolvedValue({ granted: true })
  native.setNotificationChannelAsync.mockResolvedValue(null)
  native.scheduleNotificationAsync.mockResolvedValue('notification-id')
  vi.stubGlobal('fetch', native.fetch)
  screen = undefined
  store = await import('@/store/modules/connection')
  connection = store.connection
  resetConnection()
  runtime = await import('@/store/modules/connection/runtime')
  ;({ default: HomeScreen } = await import('@/app/index'))
})

afterEach(async () => {
  await act(async () => {
    screen?.unmount()
  })
  screen = undefined
  runtime.stopConnectionRuntime()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(native.backListeners.size).toBe(0)
  expect(native.appListeners.size).toBe(0)
})

describe('rendered Home scanning and idle actions', () => {
  it('cancels the active discovery and reveals usable idle actions without a late timeout notice', async () => {
    hydrate(history.slice(0, 1))
    holdNetwork()
    let scanning!: Promise<void>
    await act(async () => {
      scanning = runtime.startAutoScan()
    })
    await mount()
    expect(texts()).toContain('寻找可用连接')
    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(1)
    const signal = native.fetch.mock.calls[0]![1]!.signal!

    await press('取消')
    await scanning

    expect(signal.aborted).toBe(true)
    expect(texts()).not.toContain('寻找可用连接')
    expect(button('自动扫描局域网').props.isDisabled).toBe(false)
    expect(button('扫码连接').props.isDisabled).toBe(false)
    expect(button('最近连接').props.isDisabled).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    expect(texts()).not.toContain('未发现可用主机，请检查设备是否在同一局域网，或扫码连接。')
  })

  it('keeps idle actions and drawer swipes disabled until hydration completes', async () => {
    connection.cancelScan()
    await mount()
    for (const label of ['自动扫描局域网', '扫码连接', '最近连接'])
      expect(button(label).props.isDisabled).toBe(true)
    expect(drawer().props.swipeEnabled).toBe(false)

    await act(async () => {
      hydrate()
    })

    for (const label of ['自动扫描局域网', '扫码连接', '最近连接'])
      expect(button(label).props.isDisabled).toBe(false)
    expect(drawer().props.swipeEnabled).toBe(true)
  })

  it('starts discovery from the idle auto-scan action and shows its network failure notice', async () => {
    const ip = Promise.withResolvers<string>()
    native.getIpAddressAsync.mockReturnValue(ip.promise)
    hydrate()
    connection.cancelScan()
    await mount()

    await press('自动扫描局域网')

    expect(texts()).toContain('扫描局域网端口中...')
    expect(root().findAll(node => String(node.type) === 'Button').map(text)).toEqual(['取消'])
    await act(async () => {
      ip.resolve('0.0.0.0')
    })
    expect(texts()).toContain('无法获取局域网 IPv4 地址，请连接 Wi-Fi 或使用扫码连接。')
    expect(button('自动扫描局域网').props.isDisabled).toBe(false)
  })

  it('uses a scanning-frame icon rather than a QR-code image at both scanner entry points', async () => {
    hydrate()
    connection.cancelScan()
    await mount()
    expect(button('扫码连接').findAll(node => String(node.type) === 'ScanLineIcon')).toHaveLength(1)
    expect(root().findAll(node => String(node.type) === 'QrCodeIcon')).toHaveLength(0)

    await press('最近连接')

    expect(button('扫码连接').findAll(node => String(node.type) === 'ScanLineIcon')).toHaveLength(1)
    expect(root().findAll(node => String(node.type) === 'QrCodeIcon')).toHaveLength(0)
  })

  it('matches the two outlined connection actions and gives auto-scan a contrasting radar icon', async () => {
    hydrate()
    connection.cancelScan()
    await mount()

    expect(button('扫码连接').props).toMatchObject({ variant: 'outline', size: 'lg' })
    expect(button('最近连接').props).toMatchObject({ variant: 'outline', size: 'lg' })
    expect(button('自动扫描局域网').find(node => String(node.type) === 'RadarIcon').props).toMatchObject({ size: 20, color: '#ffffff' })
    expect(button('最近连接').findAll(node => String(node.type) === 'HistoryIcon')).toHaveLength(1)

    native.theme = { 'background': '#151517', 'foreground': '#f9fafb', 'accent-foreground': '#0f1115' }
    await act(async () => {
      screen!.update(createElement(HomeScreen))
    })

    expect(button('自动扫描局域网').find(node => String(node.type) === 'RadarIcon').props.color).toBe('#0f1115')
    expect(button('扫码连接').findAll(node => String(node.type) === 'ScanLineIcon').map(node => node.props.color)).toEqual(['#f9fafb'])
  })

  it('renders the original whale, DeepSeek and Harness as three centered transparent SVG rows in both themes', async () => {
    hydrate()
    await mount()

    const logos = root().findAll(node => String(node.type) === 'Svg')
    expect(logos.map(node => node.props.accessibilityLabel)).toEqual(['DSH Bridge', 'DeepSeek', 'Harness'])
    expect(logos.map(node => node.props.viewBox)).toEqual(['0 0 23.16 17.04', '26 4.5 96 17.5', '129.348 5.5 52 14'])
    const brand = root().find(node => String(node.type) === 'View' && node.props.className === 'items-center gap-3')
    expect(brand.findAll(node => String(node.type) === 'Svg')).toEqual(logos)
    expect(root().findAll(node => String(node.type) === 'Image')).toHaveLength(0)
    expect(logos[0]!.findAll(node => String(node.type) === 'SvgRect')).toHaveLength(0)
    expect(logos[0]!.find(node => String(node.type) === 'SvgPath').props.fill).toBe('#0f1115')
    expect(logos[1]!.findAll(node => String(node.type) === 'SvgPath')).toHaveLength(9)
    expect(logos[1]!.findAll(node => String(node.type) === 'SvgPath').every(node => node.props.fill === '#0f1115')).toBe(true)
    expect(logos[2]!.props).toMatchObject({ width: 88, height: 23.692307692307693 })
    expect(logos[2]!.findAll(node => String(node.type) === 'SvgPath')).toHaveLength(7)
    expect(logos[2]!.findAll(node => String(node.type) === 'SvgPath').every(node => node.props.fill === '#ffffff')).toBe(true)
    expect(texts()).not.toContain('DeepSeek')
    expect(texts()).not.toContain('Harness')

    native.theme = { 'background': '#151517', 'foreground': '#f9fafb', 'accent-foreground': '#0f1115' }
    await act(async () => {
      screen!.update(createElement(HomeScreen))
    })

    const idleLogos = root().findAll(node => String(node.type) === 'Svg')
    expect(idleLogos.map(node => node.props.accessibilityLabel)).toEqual(['DSH Bridge', 'DeepSeek', 'Harness'])
    expect(idleLogos[0]!.find(node => String(node.type) === 'SvgPath').props.fill).toBe('#f9fafb')
    expect(idleLogos[1]!.findAll(node => String(node.type) === 'SvgPath').every(node => node.props.fill === '#f9fafb')).toBe(true)
    expect(idleLogos[2]!.findAll(node => String(node.type) === 'SvgPath').every(node => node.props.fill === '#151517')).toBe(true)

    await act(async () => {
      runtime.connectAddress(alpha)
    })

    expect(root().findAll(node => String(node.type) === 'Svg')).toHaveLength(0)
    expect(webView().props.source).toEqual({ uri: 'http://one.local:3080/tasks?auth=saved-token' })
  })

  it('opens the QR route from the idle scan action', async () => {
    hydrate()
    connection.cancelScan()
    await mount()

    await press('扫码连接')

    expect(native.push).toHaveBeenCalledExactlyOnceWith('/scan')
    expect(drawer().props.open).toBe(false)
    expect(connection.stage).toBe('idle')
  })
})

describe('rendered Home connection drawer', () => {
  it('uses the right slide drawer across the whole page and presents only five recent hosts with accessible status', async () => {
    hydrate(history)
    connection.cancelScan()
    connection.setHealth('http://one.local:3080', 'available')
    connection.setHealth('http://two.local:3080', 'unavailable')
    holdNetwork()
    await mount()
    expect(drawer().props).toMatchObject({ drawerPosition: 'right', drawerType: 'slide', direction: 'ltr', swipeEdgeWidth: 440, drawerStyle: { width: 384 } })
    native.dimensions = { width: 320, height: 640 }
    await act(async () => {
      screen!.update(createElement(HomeScreen))
    })
    expect(drawer().props.swipeEdgeWidth).toBe(320)
    expect(drawer().props.drawerStyle.width).toBeCloseTo(281.6)

    await press('最近连接')

    expect(drawer().props.open).toBe(true)
    const entries = root().findAll(node => String(node.type) === 'Button' && String(node.props.accessibilityLabel).includes('local:3080，'))
    expect(entries.map(node => node.props.accessibilityLabel)).toEqual([
      'one.local:3080，可用',
      'two.local:3080，不可用',
      'three.local:3080，正在检测',
      'four.local:3080，正在检测',
      'five.local:3080，正在检测',
    ])
    expect(texts()).not.toContain('six.local:3080')
    expect(texts()).not.toContain('seven.local:3080')
    expect(button('断开连接').props.isDisabled).toBe(true)
    expect(button('重新连接').props.isDisabled).toBe(true)
  })

  it('keeps the connected page free of permanent drawer controls before and after its full-screen first-use guide', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    await mount()
    const { WebView } = await import('react-native-webview')
    const instance = root().findByType(WebView).instance
    expect(root().findAll(node => node.props.accessibilityLabel === '打开连接信息')).toHaveLength(0)
    expect(root().findAll(node => String(node.type) === 'Modal')).toHaveLength(0)

    await ready()

    const modals = root().findAll(node => String(node.type) === 'Modal')
    expect(modals).toHaveLength(1)
    expect(modals[0]!.props).toMatchObject({ transparent: true, visible: true, statusBarTranslucent: true, navigationBarTranslucent: true })
    expect(modals[0]!.findAll(node => String(node.type) === 'Pressable').map(node => node.props.className)).toEqual(['flex-1 items-center justify-center gap-5 bg-black/60'])
    expect(modals[0]!.findAll(node => String(node.type) === 'Text').map(text)).toContain('向左滑查看连接信息')
    await act(async () => {
      modals[0]!.find(node => String(node.type) === 'Pressable').props.onPress()
    })

    expect(root().findAll(node => String(node.type) === 'Modal')).toHaveLength(0)
    expect(root().findAll(node => node.props.accessibilityLabel === '打开连接信息')).toHaveLength(0)
    expect(root().findByType(WebView).instance).toBe(instance)
    expect(connection.guidedHosts).toEqual(['http://one.local:3080'])
    await act(async () => {
      drawer().props.onOpen()
      drawer().props.onClose()
    })
    expect(root().findByType(WebView).instance).toBe(instance)
    expect(root().findAll(node => String(node.type) === 'Modal')).toHaveLength(0)
  })

  it('does not consume first-use guidance when the drawer is opened before the page is ready', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    await mount()
    await act(async () => {
      drawer().props.onOpen()
    })
    expect(connection.guidedHosts).toEqual([])
    await ready()
    expect(root().findAll(node => String(node.type) === 'Modal')).toHaveLength(0)
    await act(async () => {
      drawer().props.onClose()
    })

    const modals = root().findAll(node => String(node.type) === 'Modal')
    expect(modals).toHaveLength(1)
    expect(modals[0]!.findAll(node => String(node.type) === 'Text').map(text)).toContain('向左滑查看连接信息')
    await act(async () => {
      modals[0]!.props.onRequestClose()
    })
    expect(connection.guidedHosts).toEqual(['http://one.local:3080'])
    expect(root().findAll(node => String(node.type) === 'Modal')).toHaveLength(0)
  })

  it('keeps the drawer heading close to the current connection without restoring a card wrapper', async () => {
    hydrate()
    connection.cancelScan()
    await mount()
    await press('最近连接')

    const heading = root().findAll(node => String(node.type) === 'View').find(node => node.findAll(child => String(child.type) === 'Button' && child.props.accessibilityLabel === '扫码连接').length === 1 && node.findAll(child => String(child.type) === 'Text').map(text).includes('连接信息') && node.props.className?.includes('justify-between'))
    expect(heading?.props.className).toBe('flex-row items-center justify-between px-5 pb-1 pt-2')
    expect(button('重新连接').props.className).toBe('h-auto min-h-16 justify-start gap-3 rounded-xl px-3 py-4')
  })

  it('uses the same title-and-item style for current and recent hosts with only status dots in the rows', async () => {
    hydrate(history)
    runtime.connectAddress(alpha)
    holdNetwork()
    await mount()
    await act(async () => {
      drawer().props.onOpen()
    })

    expect(texts()).toContain('当前连接')
    expect(texts()).toContain('最近连接')
    const current = button('重新连接')
    const recent = button('one.local:3080，可用')
    expect(current.props.variant).toBe('ghost')
    expect(current.props.className).toBe(recent.props.className)
    expect(text(current)).toBe('one.local:3080')
    expect(text(recent)).toBe('one.local:3080')
    expect(current.findAll(node => String(node.type) === 'View' && node.props.className?.includes('bg-success'))).toHaveLength(1)
    expect(recent.findAll(node => String(node.type) === 'View' && node.props.className?.includes('bg-success'))).toHaveLength(1)
    expect(texts()).not.toContain('可用')
    expect(texts()).not.toContain('不可用')
    expect(root().findAll(node => String(node.type) === 'View' && node.props.className?.includes('border-border') && node.props.className?.includes('bg-surface-secondary'))).toHaveLength(0)
    const refresh = button('刷新最近连接')
    expect(root().findAll(node => String(node.type) === 'RefreshIcon')).toEqual(refresh.findAll(node => String(node.type) === 'RefreshIcon'))

    await press('重新连接')

    expect(drawer().props.open).toBe(false)
    expect(connection.viewGeneration).toBe(2)
    expect(webView().props.source).toEqual({ uri: 'http://one.local:3080/tasks?auth=saved-token' })
  })

  it('refreshes host availability from the recent header without reconnecting or duplicating active probes', async () => {
    hydrate(history.slice(0, 1))
    connection.cancelScan()
    await mount()
    await press('最近连接')
    expect(button('one.local:3080，可用').props.isDisabled).not.toBe(true)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    const refresh = button('刷新最近连接')
    expect(refresh.props).toMatchObject({ variant: 'ghost', isIconOnly: true })
    const header = root().findAll(node => String(node.type) === 'View' && node.props.className === 'flex-row items-center justify-between').find(node => node.findAll(child => String(child.type) === 'Text').map(text).includes('最近连接'))
    expect(header?.findAll(node => String(node.type) === 'RefreshIcon')).toHaveLength(1)
    expect(button('one.local:3080，可用').findAll(node => String(node.type) === 'RefreshIcon')).toHaveLength(0)

    native.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    await press('刷新最近连接')

    expect(native.fetch).toHaveBeenCalledTimes(2)
    expect(button('one.local:3080，不可用').findAll(node => String(node.type) === 'View' && node.props.className?.includes('bg-danger'))).toHaveLength(1)
    expect(texts()).not.toContain('不可用')
    expect(connection.current).toBeNull()
    expect(drawer().props.open).toBe(true)
    holdNetwork()
    await press('刷新最近连接')
    await press('刷新最近连接')
    expect(native.fetch).toHaveBeenCalledTimes(3)
    expect(native.fetch.mock.calls[2]![0]).toBe('http://one.local:3080/__dsh_bridge__/auth-status')
    expect(connection.viewGeneration).toBe(0)
  })

  it('connects a tapped recent host using its saved token and closes the drawer', async () => {
    hydrate(history)
    connection.cancelScan()
    holdNetwork()
    await mount()
    await press('最近连接')

    await press('one.local:3080，正在检测')

    expect(drawer().props.open).toBe(false)
    expect(webView().props.source).toEqual({ uri: 'http://one.local:3080/tasks?auth=saved-token' })
    expect(texts()).toContain('寻找可用连接')
    expect(connection.stage).toBe('connected')
  })

  it('cancels discovery and closes the drawer before opening its QR action', async () => {
    hydrate(history.slice(0, 1))
    holdNetwork()
    let scanning!: Promise<void>
    await act(async () => {
      scanning = runtime.startAutoScan()
    })
    await mount()
    await act(async () => {
      drawer().props.onOpen()
    })
    const signal = native.fetch.mock.calls[0]![1]!.signal!

    await press('扫码连接')
    await scanning

    expect(signal.aborted).toBe(true)
    expect(native.push).toHaveBeenCalledExactlyOnceWith('/scan')
    expect(drawer().props.open).toBe(false)
    expect(button('自动扫描局域网').props.isDisabled).toBe(false)
  })

  it('disconnects the displayed host back to visible scanning without losing successful history', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    await mount()
    await ready()
    await act(async () => {
      drawer().props.onOpen()
    })
    holdNetwork()

    await press('断开连接')

    expect(root().findAll(node => String(node.type) === 'WebView')).toHaveLength(0)
    expect(drawer().props.open).toBe(false)
    expect(texts()).toContain('寻找可用连接')
    expect(button('取消').props.isDisabled).not.toBe(true)
    expect(connection.current).toBeNull()
    expect(connection.history.map(entry => entry.id)).toEqual(['http://one.local:3080'])
  })

  it('dismisses the first-host swipe hint when the native drawer is swiped open', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    await mount()
    await ready()
    expect(texts()).toContain('向左滑查看连接信息')

    await act(async () => {
      drawer().props.onOpen()
    })

    expect(drawer().props.open).toBe(true)
    expect(texts()).not.toContain('向左滑查看连接信息')
    expect(connection.guidedHosts).toEqual(['http://one.local:3080'])
    await press('关闭连接信息')
    expect(texts()).not.toContain('向左滑查看连接信息')
  })

  it('preserves the same native WebView instance and URL through drawer swipes and button toggles', async () => {
    hydrate()
    runtime.connectAddress(alpha)
    await mount()
    await ready()
    const { WebView } = await import('react-native-webview')
    const instance = root().findByType(WebView).instance

    await act(async () => {
      drawer().props.onOpen()
    })
    expect(root().findByType(WebView).instance).toBe(instance)
    await act(async () => {
      drawer().props.onClose()
    })
    expect(root().findByType(WebView).instance).toBe(instance)
    await act(async () => {
      drawer().props.onOpen()
    })
    expect(root().findByType(WebView).instance).toBe(instance)
    await press('关闭连接信息')

    expect(root().findByType(WebView).instance).toBe(instance)
    expect(webView().props.source).toEqual({ uri: 'http://one.local:3080/tasks?auth=saved-token' })
    expect(texts()).not.toContain('寻找可用连接')
  })
})

describe('rendered Home Android back handling', () => {
  it('closes a focused Home drawer and then leaves further back events unconsumed', async () => {
    hydrate()
    connection.cancelScan()
    await mount()
    await press('最近连接')
    const handler = [...native.backListeners][0]!
    let consumed: boolean | undefined

    await act(async () => {
      consumed = handler()
    })

    expect(consumed).toBe(true)
    expect(drawer().props.open).toBe(false)
    expect(handler()).toBe(false)
  })

  it('does not consume scanner-modal back events when Home navigation is not focused', async () => {
    hydrate()
    connection.cancelScan()
    await mount()
    await press('最近连接')
    native.navigation.isFocused.mockReturnValue(false)
    const handler = [...native.backListeners][0]!
    let consumed: boolean | undefined

    await act(async () => {
      consumed = handler()
    })

    expect(consumed).toBe(false)
    expect(drawer().props.open).toBe(true)
    expect(texts()).toContain('连接信息')
  })
})
