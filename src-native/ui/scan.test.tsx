import type { ReactNode } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'
import { act, createElement } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CameraPermission {
  granted: boolean
  canAskAgain: boolean
  status: 'denied' | 'granted'
  expires: 'never'
}

const native = vi.hoisted(() => ({
  permission: null as CameraPermission | null,
  appState: { currentState: 'active' },
  appListeners: new Set<() => void>(),
  requestPermission: vi.fn<() => Promise<CameraPermission>>(),
  refreshPermission: vi.fn<() => Promise<CameraPermission>>(),
  openSettings: vi.fn<() => Promise<void>>(),
  back: vi.fn<() => void>(),
  cancelAnimation: vi.fn(),
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Platform: { OS: 'android' },
  Linking: { openSettings: native.openSettings },
  AppState: {
    get currentState() { return native.appState.currentState },
    addEventListener: (_event: string, listener: () => void) => {
      native.appListeners.add(listener)
      return { remove: () => {
        native.appListeners.delete(listener)
      } }
    },
  },
}))
vi.mock('expo-router', () => ({ router: { back: native.back } }))
// 文案与 store 现在都经过 i18n；node 环境无法真正加载 expo-localization（缺 __DEV__），设备区域固定为 zh-CN。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
// store 模块经 valtio-define persist 插件依赖 AsyncStorage，node 环境用最小实现顶替。
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }))
vi.mock('expo-network', () => ({ getIpAddressAsync: vi.fn(async () => '0.0.0.0') }))
vi.mock('expo-notifications', () => ({ AndroidImportance: { DEFAULT: 5, HIGH: 6 } }))
vi.mock('expo-camera', async () => {
  const { useRef, useState } = await import('react')
  function useCameraPermissions() {
    const [permission, setPermission] = useState(native.permission)
    const methodsRef = useRef({
      request: async () => {
        const value = await native.requestPermission()
        setPermission(value)
        return value
      },
      refresh: async () => {
        const value = await native.refreshPermission()
        setPermission(value)
        return value
      },
    })
    return [permission, methodsRef.current.request, methodsRef.current.refresh]
  }
  return { CameraView: 'CameraView', useCameraPermissions }
})
vi.mock('heroui-native/hooks', () => ({ useThemeColor: (names: string[]) => names.map(() => '#ffffff') }))
vi.mock('heroui-native/button', async () => {
  const { createElement } = await import('react')
  function Button({ children, ...props }: { children?: ReactNode }) {
    return createElement('Button', props, children)
  }
  return { Button: Object.assign(Button, { Label: 'Text' }) }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('react-native-lucide', () => ({ X: 'Icon' }))
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

const denied: CameraPermission = { granted: false, canAskAgain: true, status: 'denied', expires: 'never' }
const granted: CameraPermission = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' }
let screen: ReactTestRenderer | undefined
let store: typeof import('@/store/modules/connection')
let connection: typeof import('@/store/modules/connection').connection
let runtime: typeof import('@/store/modules/connection/runtime')
let ScanScreen: typeof import('@/app/scan').default

/** persist 插件在模块加载时就已经订阅 state，必须先复位插件元数据，否则下面的 `$patch` 会立刻写一次盘。 */
function resetConnection() {
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(store.createConnectionState())
  store.resetConnectionStorageCache()
  vi.clearAllMocks()
}

/** 与 restoreConnections() 等价的水合：快照进 state，令牌单独落 map，hydrated 由 markHydrated 置位。 */
function hydrate(tokens: Record<string, string> = {}) {
  connection.$patch(store.parseConnectionSnapshot({ version: 1, history: [], guidedHosts: [] }))
  connection.markHydrated(tokens)
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string')
    return node
  return node.children.map(text).join('')
}

function root() {
  if (!screen)
    throw new Error('Scanner screen is not mounted')
  return screen.root
}

function texts() {
  return root().findAll(node => String(node.type) === 'Text').map(text)
}

function button(label: string) {
  const matches = root().findAll(node => String(node.type) === 'Button' && (node.props.accessibilityLabel === label || text(node) === label))
  expect(matches, `Button ${label}`).toHaveLength(1)
  return matches[0]!
}

function camera() {
  return root().find(node => String(node.type) === 'CameraView')
}

async function press(label: string) {
  await act(async () => {
    await button(label).props.onPress()
  })
}

async function mount() {
  await act(async () => {
    screen = create(createElement(ScanScreen))
  })
}

async function changeAppState(state: string) {
  await act(async () => {
    native.appState.currentState = state
    for (const listener of native.appListeners)
      listener()
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer')
      return
    originalError(...args)
  })
  native.appState.currentState = 'active'
  native.appListeners.clear()
  native.permission = granted
  native.refreshPermission.mockImplementation(async () => {
    if (!native.permission)
      throw new Error('Test permission has not been resolved')
    return native.permission
  })
  native.requestPermission.mockResolvedValue(denied)
  native.openSettings.mockResolvedValue(undefined)
  screen = undefined
  store = await import('@/store/modules/connection')
  connection = store.connection
  resetConnection()
  runtime = await import('@/store/modules/connection/runtime')
  ;({ default: ScanScreen } = await import('@/app/scan'))
  hydrate()
})

afterEach(async () => {
  await act(async () => {
    screen?.unmount()
  })
  screen = undefined
  runtime.stopConnectionRuntime()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(native.appListeners.size).toBe(0)
})

describe('rendered scanner camera permissions', () => {
  it('shows a loader while permission is unresolved, then offers the denied-camera action', async () => {
    native.permission = null
    const permission = Promise.withResolvers<CameraPermission>()
    native.refreshPermission.mockReturnValue(permission.promise)
    await mount()
    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(1)
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)

    await act(async () => {
      permission.resolve(denied)
    })

    expect(root().findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(0)
    expect(texts()).toContain('需要相机权限才能扫描连接二维码。')
    expect(text(button('允许使用相机'))).toBe('允许使用相机')
  })

  it('requests camera access after denial and keeps QR scanning unavailable when permission stays denied', async () => {
    native.permission = denied
    await mount()

    await press('允许使用相机')

    expect(native.requestPermission).toHaveBeenCalledExactlyOnceWith()
    expect(native.openSettings).not.toHaveBeenCalled()
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(texts()).toContain('需要相机权限才能扫描连接二维码。')
    expect(native.back).not.toHaveBeenCalled()
    expect(connection.current).toBeNull()
  })

  it('renders the camera when an explicit permission request is granted', async () => {
    native.permission = denied
    native.requestPermission.mockResolvedValue(granted)
    await mount()

    await press('允许使用相机')

    expect(camera().props).toMatchObject({ facing: 'back', barcodeScannerSettings: { barcodeTypes: ['qr'] } })
    expect(camera().props.onBarcodeScanned).toBeTypeOf('function')
    expect(texts()).not.toContain('需要相机权限才能扫描连接二维码。')
  })

  it('opens system settings for permanent denial and refreshes permission when the app returns', async () => {
    native.permission = { ...denied, canAskAgain: false }
    await mount()
    expect(text(button('打开系统设置'))).toBe('打开系统设置')

    await press('打开系统设置')

    expect(native.openSettings).toHaveBeenCalledExactlyOnceWith()
    expect(native.requestPermission).not.toHaveBeenCalled()
    await changeAppState('background')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    native.permission = granted
    await changeAppState('active')
    expect(native.refreshPermission).toHaveBeenCalledTimes(2)
    expect(camera().props.onBarcodeScanned).toBeTypeOf('function')
    expect(texts()).toContain('扫描桌面端或 DSH Bridge 中的连接二维码')
    expect(texts()).not.toContain('需要相机权限才能扫描连接二维码。')
  })

  it('unmounts the camera in the background and observes a permission revocation on return', async () => {
    await mount()
    expect(camera().props.facing).toBe('back')

    await changeAppState('background')

    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    native.permission = { ...denied, canAskAgain: false }
    await changeAppState('active')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(text(button('打开系统设置'))).toBe('打开系统设置')
    expect(native.refreshPermission).toHaveBeenCalledTimes(2)
  })

  it.each(['request', 'settings'] as const)('shows the camera error when the %s permission action rejects', async (operation) => {
    native.permission = denied
    let label = '允许使用相机'
    if (operation === 'settings') {
      native.permission = { ...denied, canAskAgain: false }
      native.openSettings.mockRejectedValue(new Error('Settings unavailable'))
      label = '打开系统设置'
    }
    else {
      native.requestPermission.mockRejectedValue(new Error('Camera request unavailable'))
    }
    await mount()

    await press(label)

    expect(texts()).toContain('无法打开相机，请检查相机权限后重试。')
    expect(root().findAll(node => String(node.type) === 'CameraView')).toHaveLength(0)
    expect(connection.current).toBeNull()
    expect(native.back).not.toHaveBeenCalled()
  })

  it('shows a visible error when refreshing native camera permission fails on foreground return', async () => {
    await mount()
    await changeAppState('background')
    native.refreshPermission.mockRejectedValue(new Error('Camera refresh failed'))

    await changeAppState('active')

    expect(texts()).toContain('无法打开相机，请检查相机权限后重试。')
    expect(text(button('重新扫码'))).toBe('重新扫码')
    expect(native.back).not.toHaveBeenCalled()
  })
})

describe('rendered scanner QR events', () => {
  it('accepts only the first valid QR event before React commits and returns to Home once', async () => {
    await mount()
    const scan = camera().props.onBarcodeScanned

    await act(async () => {
      scan({ data: 'http://bridge.local:3080/tasks?auth=qr-token&theme=dark#fragment' })
      scan({ data: 'https://second.local/' })
    })

    expect(connection.current).toEqual({ id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks?theme=dark', host: 'bridge.local', port: 3080, token: 'qr-token' })
    expect(connection.stage).toBe('connected')
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'qr-token' })
    expect(native.back).toHaveBeenCalledExactlyOnceWith()
    expect(camera().props.onBarcodeScanned).toBeUndefined()
    const generation = connection.viewGeneration
    await act(async () => {
      scan({ data: 'https://second.local/' })
    })
    expect(native.back).toHaveBeenCalledTimes(1)
    expect(connection.viewGeneration).toBe(generation)
    expect(connection.current?.id).toBe('http://bridge.local:3080')
  })

  it('locks an invalid QR result until the visible retry action enables a fresh valid scan', async () => {
    await mount()
    const scan = camera().props.onBarcodeScanned

    await act(async () => {
      scan({ data: 'not a connection QR code' })
      scan({ data: 'http://ignored.local:3080/' })
    })

    expect(texts()).toContain('二维码中没有有效的 HTTP/HTTPS 连接地址。')
    expect(camera().props.onBarcodeScanned).toBeUndefined()
    expect(connection.current).toBeNull()
    expect(native.back).not.toHaveBeenCalled()
    await press('重新扫码')
    expect(texts()).not.toContain('二维码中没有有效的 HTTP/HTTPS 连接地址。')
    expect(camera().props.onBarcodeScanned).toBeTypeOf('function')
    await act(async () => {
      camera().props.onBarcodeScanned({ data: '{"url":"https://bridge.local/tasks?token=fresh"}' })
    })
    expect(connection.current).toEqual({ id: 'https://bridge.local', url: 'https://bridge.local/tasks', host: 'bridge.local', port: 443, token: 'fresh' })
    expect(native.back).toHaveBeenCalledExactlyOnceWith()
  })

  it('presents native camera mount failures with a retry action that clears the error', async () => {
    await mount()

    await act(async () => {
      camera().props.onMountError({ message: 'Camera unavailable' })
    })

    expect(texts()).toContain('无法打开相机，请检查相机权限后重试。')
    await press('重新扫码')
    expect(texts()).not.toContain('无法打开相机，请检查相机权限后重试。')
    expect(camera().props.onBarcodeScanned).toBeTypeOf('function')
    expect(connection.current).toBeNull()
  })

  it('closes the scanner without changing the current connection', async () => {
    runtime.connectAddress({ id: 'https://existing.local', url: 'https://existing.local/tasks', host: 'existing.local', port: 443 })
    await mount()

    await press('关闭扫码')

    expect(native.back).toHaveBeenCalledExactlyOnceWith()
    expect(connection.current).toEqual({ id: 'https://existing.local', url: 'https://existing.local/tasks', host: 'existing.local', port: 443 })
    expect(connection.stage).toBe('connected')
  })
})
