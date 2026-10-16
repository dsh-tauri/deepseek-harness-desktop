import type { Notification, NotificationHandler, NotificationPermissionsStatus, NotificationResponse } from 'expo-notifications'
import type { EffectCallback } from 'react'
import type { NativeNotificationMessage } from '@/utils/notification-policy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'

const native = vi.hoisted(() => ({
  appState: { currentState: 'active' },
  platform: { OS: 'android' },
  useEffect: vi.fn<typeof import('react').useEffect>(),
  setNotificationChannelAsync: vi.fn<typeof import('expo-notifications').setNotificationChannelAsync>(),
  getPermissionsAsync: vi.fn<typeof import('expo-notifications').getPermissionsAsync>(),
  requestPermissionsAsync: vi.fn<typeof import('expo-notifications').requestPermissionsAsync>(),
  scheduleNotificationAsync: vi.fn<typeof import('expo-notifications').scheduleNotificationAsync>(),
  setNotificationHandler: vi.fn<typeof import('expo-notifications').setNotificationHandler>(),
  addNotificationResponseReceivedListener: vi.fn<typeof import('expo-notifications').addNotificationResponseReceivedListener>(),
  getLastNotificationResponseAsync: vi.fn<typeof import('expo-notifications').getLastNotificationResponseAsync>(),
  clearLastNotificationResponseAsync: vi.fn<typeof import('expo-notifications').clearLastNotificationResponseAsync>(),
  remove: vi.fn<() => void>(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: native.useEffect }
})
vi.mock('react-native', () => ({ AppState: native.appState, Platform: native.platform }))
// 通知渠道名来自 i18n；node 环境无法真正加载 expo-localization（缺 __DEV__），设备区域固定为 zh-CN。
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
// store 模块经 valtio-define persist 插件依赖 AsyncStorage，node 环境用最小实现顶替。
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }))
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationChannelAsync: native.setNotificationChannelAsync,
  getPermissionsAsync: native.getPermissionsAsync,
  requestPermissionsAsync: native.requestPermissionsAsync,
  scheduleNotificationAsync: native.scheduleNotificationAsync,
  setNotificationHandler: native.setNotificationHandler,
  addNotificationResponseReceivedListener: native.addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync: native.getLastNotificationResponseAsync,
  clearLastNotificationResponseAsync: native.clearLastNotificationResponseAsync,
}))

const origin = 'https://harness.test:3080'
const message: NativeNotificationMessage = {
  type: 'dsh://native-notification',
  title: 'Response complete',
  body: 'Your answer is ready',
  sessionId: 'session',
  tag: 'dsh-notification-session-1',
  silent: false,
}
const permissionGranted = {
  status: 'granted',
  granted: true,
  canAskAgain: true,
  expires: 'never',
} as NotificationPermissionsStatus
const permissionDenied = {
  status: 'denied',
  granted: false,
  canAskAgain: true,
  expires: 'never',
} as NotificationPermissionsStatus
let effects: EffectCallback[] = []
let dispose: (() => void) | undefined

function notification(sound: Notification['request']['content']['sound'] = 'default', data: unknown = {
  origin,
  sessionId: 'session',
  title: 'Response complete',
  tag: 'dsh-notification-session-1',
}): Notification {
  const result: Notification = {
    date: 1000,
    request: {
      identifier: '1525991148',
      trigger: { channelId: 'dsh-bridge' },
      content: { title: 'Response complete', subtitle: null, body: 'Your answer is ready', categoryIdentifier: null, sound },
    },
  }
  Reflect.set(result.request.content, 'data', data)
  return result
}

function response(data?: unknown): NotificationResponse {
  return { notification: notification('default', data), actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' }
}

async function mountNotifications() {
  const hooks = await import('./use-notifications')
  const { connection } = await import('@/store/modules/connection')
  hooks.useNotifications()
  expect(effects).toHaveLength(1)
  const effect = effects[0]
  if (!effect)
    throw new Error('Notification effect was not registered')
  const cleanup = effect()
  if (typeof cleanup !== 'function')
    throw new Error('Notification effect did not provide cleanup')
  dispose = cleanup
  const handler: NotificationHandler | null | undefined = native.setNotificationHandler.mock.calls[0]?.[0]
  const listener = native.addNotificationResponseReceivedListener.mock.calls[0]?.[0]
  expect(handler).not.toBeNull()
  expect(listener).toBeTypeOf('function')
  if (!handler || !listener)
    throw new Error('Native notification handlers were not registered')
  return { ...hooks, connection, handler, listener }
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  native.appState.currentState = 'active'
  native.platform.OS = 'android'
  effects = []
  dispose = undefined
  native.useEffect.mockImplementation((effect) => {
    effects.push(effect)
  })
  native.setNotificationChannelAsync.mockResolvedValue(null)
  native.getPermissionsAsync.mockResolvedValue(permissionGranted)
  native.requestPermissionsAsync.mockResolvedValue(permissionGranted)
  native.scheduleNotificationAsync.mockResolvedValue('native-id')
  native.addNotificationResponseReceivedListener.mockReturnValue({ remove: native.remove })
  native.getLastNotificationResponseAsync.mockResolvedValue(null)
  native.clearLastNotificationResponseAsync.mockResolvedValue(undefined)
})

afterEach(() => {
  dispose?.()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('native notification delivery', () => {
  it('suppresses foreground delivery before touching the native permission API', async () => {
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification(message, origin)

    expect(native.setNotificationChannelAsync).not.toHaveBeenCalled()
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
  })

  it.each([
    [false, 'dsh-bridge', true],
    [true, 'dsh-bridge-silent', false],
  ] as const)('delivers Android silent=%s immediately on %s with native sound=%s', async (silent, channelId, sound) => {
    native.appState.currentState = 'background'
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification({ ...message, silent }, origin)

    expect(native.setNotificationChannelAsync.mock.calls).toEqual([
      ['dsh-bridge', { name: i18n.t('notification.channel'), importance: 6, sound: 'default', vibrationPattern: [0, 200] }],
      ['dsh-bridge-silent', { name: i18n.t('notification.channelSilent'), importance: 5, sound: null, enableVibrate: false }],
    ])
    expect(native.scheduleNotificationAsync.mock.calls).toEqual([[{
      identifier: '1525991148',
      content: {
        title: 'Response complete',
        body: 'Your answer is ready',
        sound,
        data: { origin: 'https://harness.test:3080', sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' },
      },
      trigger: { channelId },
    }]])
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('delivers an iOS notification immediately without creating Android channels', async () => {
    native.appState.currentState = 'background'
    native.platform.OS = 'ios'
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification(message, origin)

    expect(native.setNotificationChannelAsync).not.toHaveBeenCalled()
    expect(native.scheduleNotificationAsync).toHaveBeenCalledExactlyOnceWith({
      identifier: '1525991148',
      content: {
        title: 'Response complete',
        body: 'Your answer is ready',
        sound: true,
        data: { origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' },
      },
      trigger: null,
    })
  })

  it('never presents a permission prompt from the background when access is denied', async () => {
    native.appState.currentState = 'background'
    native.getPermissionsAsync.mockResolvedValue(permissionDenied)
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification(message, origin)

    expect(native.getPermissionsAsync).toHaveBeenCalledExactlyOnceWith()
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
  })

  it('shares a single native permission check and prompt across concurrent callers', async () => {
    const check = Promise.withResolvers<NotificationPermissionsStatus>()
    const request = Promise.withResolvers<NotificationPermissionsStatus>()
    const requestStarted = Promise.withResolvers<void>()
    native.getPermissionsAsync.mockReturnValue(check.promise)
    native.requestPermissionsAsync.mockImplementation(() => {
      requestStarted.resolve()
      return request.promise
    })
    const { requestNotificationAccess } = await import('./use-notifications')

    const first = requestNotificationAccess()
    expect(requestNotificationAccess()).toBe(first)
    check.resolve(permissionDenied)
    await requestStarted.promise
    expect(requestNotificationAccess()).toBe(first)
    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(native.requestPermissionsAsync).toHaveBeenCalledExactlyOnceWith()
    request.resolve(permissionGranted)
    await expect(first).resolves.toBe(true)
    expect(native.setNotificationChannelAsync).toHaveBeenCalledTimes(2)
  })

  it('retries channel initialization after a native failure', async () => {
    const error = new Error('Android channel unavailable')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.setNotificationChannelAsync.mockRejectedValueOnce(error)
    const { requestNotificationAccess } = await import('./use-notifications')

    await expect(requestNotificationAccess()).resolves.toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith('[notification] permission request failed:', error)
    expect(native.getPermissionsAsync).not.toHaveBeenCalled()
    await expect(requestNotificationAccess()).resolves.toBe(true)

    expect(native.setNotificationChannelAsync).toHaveBeenCalledTimes(4)
    expect(native.getPermissionsAsync).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['getPermissionsAsync', 'requestPermissionsAsync'] as const)('retries permission after %s rejects', async (operation) => {
    const error = new Error(`${operation} failed`)
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.getPermissionsAsync.mockResolvedValue(operation === 'requestPermissionsAsync' ? permissionDenied : permissionGranted)
    native[operation].mockRejectedValueOnce(error)
    const { requestNotificationAccess } = await import('./use-notifications')

    await expect(requestNotificationAccess()).resolves.toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith('[notification] permission request failed:', error)
    await expect(requestNotificationAccess()).resolves.toBe(true)

    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(2)
    expect(native.requestPermissionsAsync).toHaveBeenCalledTimes(operation === 'requestPermissionsAsync' ? 2 : 0)
    expect(native.setNotificationChannelAsync).toHaveBeenCalledTimes(2)
  })

  it('observes a settings grant on the next background notification', async () => {
    native.appState.currentState = 'background'
    native.getPermissionsAsync.mockResolvedValueOnce(permissionDenied).mockResolvedValueOnce(permissionGranted)
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification(message, origin)
    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
    await sendNativeNotification(message, origin)

    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(2)
    expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(1)
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('observes a settings revocation rather than caching granted access', async () => {
    native.appState.currentState = 'background'
    native.getPermissionsAsync.mockResolvedValueOnce(permissionGranted).mockResolvedValueOnce(permissionDenied)
    const { sendNativeNotification } = await import('./use-notifications')

    await sendNativeNotification(message, origin)
    await sendNativeNotification(message, origin)

    expect(native.getPermissionsAsync).toHaveBeenCalledTimes(2)
    expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(1)
    expect(native.requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('drops delivery when the app becomes active while native permission is pending', async () => {
    native.appState.currentState = 'background'
    const check = Promise.withResolvers<NotificationPermissionsStatus>()
    const checkStarted = Promise.withResolvers<void>()
    native.getPermissionsAsync.mockImplementation(() => {
      checkStarted.resolve()
      return check.promise
    })
    const { sendNativeNotification } = await import('./use-notifications')

    const pending = sendNativeNotification(message, origin)
    await checkStarted.promise
    native.appState.currentState = 'active'
    check.resolve(permissionGranted)
    await pending

    expect(native.scheduleNotificationAsync).not.toHaveBeenCalled()
  })

  it('reports native scheduling failure without blocking the next delivery', async () => {
    native.appState.currentState = 'background'
    const error = new Error('Native schedule failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.scheduleNotificationAsync.mockRejectedValueOnce(error)
    const { sendNativeNotification } = await import('./use-notifications')

    await expect(sendNativeNotification(message, origin)).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledExactlyOnceWith('[notification] send failed:', error)
    await sendNativeNotification(message, origin)

    expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(1)
  })
})

describe('native notification presentation', () => {
  it('suppresses foreground banners, list entries, sound, and badge updates', async () => {
    const { handler } = await mountNotifications()

    await expect(handler.handleNotification(notification('default'))).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    })
  })

  it.each(['default', null] as const)('uses Expo output sound=%s to select background audio', async (sound) => {
    const { handler } = await mountNotifications()
    native.appState.currentState = 'background'

    await expect(handler.handleNotification(notification(sound))).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: sound === 'default',
      shouldSetBadge: false,
    })
  })
})

describe('native notification clicks', () => {
  it('restores a validated cold click into the real connection focus queue', async () => {
    const cold = response()
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection } = await mountNotifications()
    expect(connection.pendingFocus).toBeNull()

    restore.resolve(cold)
    await restore.promise

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledExactlyOnceWith()
  })

  it('queues a validated warm click with bounded session metadata', async () => {
    const { connection, listener } = await mountNotifications()

    listener(response({ origin, sessionId: 's'.repeat(300), title: 't'.repeat(300), tag: 'g'.repeat(300) }))

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 's'.repeat(256), title: 't'.repeat(256), tag: 'g'.repeat(256) })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledExactlyOnceWith()
  })

  it('normalizes absent or non-string optional click metadata', async () => {
    const { connection, listener } = await mountNotifications()

    listener(response({ origin, sessionId: 12, title: null }))

    expect(connection.pendingFocus).toEqual({ origin, sessionId: '', title: '', tag: '' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { origin: 12 },
    { origin: 'javascript:alert(1)' },
    { origin: 'https://user:secret@harness.test:3080' },
    { origin: 'harness.test:3080' },
    { origin: 'https://harness.test:3080/' },
    { origin: 'https://harness.test:3080?auth=secret' },
    { origin: 'https://HARNESS.test:3080' },
  ])('rejects native click data without an exact canonical HTTP origin: %j', async (data) => {
    const { connection, listener } = await mountNotifications()
    const malformed = response()
    Reflect.set(malformed.notification.request.content, 'data', data)

    listener(malformed)

    expect(connection.pendingFocus).toBeNull()
    expect(native.clearLastNotificationResponseAsync).not.toHaveBeenCalled()
  })

  it('ignores non-default notification actions', async () => {
    const { connection, listener } = await mountNotifications()

    listener({ ...response(), actionIdentifier: 'reply-action' })

    expect(connection.pendingFocus).toBeNull()
    expect(native.clearLastNotificationResponseAsync).not.toHaveBeenCalled()
  })

  it('coalesces a restored cold click with its immediate warm duplicate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    const click = response()
    restore.resolve(click)
    await restore.promise
    connection.queueFocus(null)

    listener(click)

    expect(connection.pendingFocus).toBeNull()
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
  })

  it('does not replay a warm click when its cold snapshot resolves after the coalescing window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    const click = response()
    listener(click)
    connection.queueFocus(null)
    vi.advanceTimersByTime(1000)

    restore.resolve(click)
    await restore.promise

    expect(connection.pendingFocus).toBeNull()
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
  })

  it('does not let an older cold snapshot overwrite a newer validated warm focus', async () => {
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    const oldClick = response({ origin, sessionId: 'old-session', title: 'Old answer', tag: 'old-tag' })
    const newClick = response({ origin, sessionId: 'new-session', title: 'New answer', tag: 'new-tag' })
    newClick.notification.request.identifier = 'new-native-id'
    newClick.notification.date = 2000
    listener(newClick)

    restore.resolve(oldClick)
    await restore.promise

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'new-session', title: 'New answer', tag: 'new-tag' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
  })

  it('still restores a valid cold click after rejecting a malformed warm event', async () => {
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    listener(response({ origin: 'https://user:secret@harness.test:3080' }))

    restore.resolve(response())
    await restore.promise

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
  })

  it('coalesces warm duplicates for 250ms without suppressing a later genuine click', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { connection, listener } = await mountNotifications()
    const click = response()
    listener(click)
    connection.queueFocus(null)
    vi.advanceTimersByTime(249)
    listener(click)
    expect(connection.pendingFocus).toBeNull()
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)

    listener(click)

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(2)
  })

  it('distinguishes native responses sharing an identifier but having different dates', async () => {
    const { connection, listener } = await mountNotifications()
    const first = response()
    const second = response({ origin, sessionId: 'next-session', title: 'Next answer', tag: 'next-tag' })
    second.notification.date = 2000
    listener(first)
    connection.queueFocus(null)

    listener(second)

    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'next-session', title: 'Next answer', tag: 'next-tag' })
    expect(native.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(2)
  })

  it('disposes presentation and ignores retained warm callbacks or pending cold responses', async () => {
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    if (!dispose)
      throw new Error('Notification cleanup is missing')
    dispose()
    dispose = undefined
    listener(response())
    restore.resolve(response())
    await restore.promise

    expect(connection.pendingFocus).toBeNull()
    expect(native.remove).toHaveBeenCalledExactlyOnceWith()
    expect(native.setNotificationHandler).toHaveBeenLastCalledWith(null)
    expect(native.clearLastNotificationResponseAsync).not.toHaveBeenCalled()
  })

  it('reports cold response restoration failure without dropping subsequent warm clicks', async () => {
    const error = new Error('Cold response unavailable')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restore = Promise.withResolvers<NotificationResponse | null>()
    native.getLastNotificationResponseAsync.mockReturnValue(restore.promise)
    const { connection, listener } = await mountNotifications()
    restore.reject(error)
    await expect(restore.promise).rejects.toThrow('Cold response unavailable')

    listener(response())

    expect(report).toHaveBeenCalledExactlyOnceWith('[notification] restore response failed:', error)
    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' })
  })

  it('reports native response clearing failure while preserving queued focus', async () => {
    const error = new Error('Response clear failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clear = Promise.withResolvers<void>()
    native.clearLastNotificationResponseAsync.mockReturnValue(clear.promise)
    const { connection, listener } = await mountNotifications()
    listener(response())
    clear.reject(error)
    await expect(clear.promise).rejects.toThrow('Response clear failed')

    expect(report).toHaveBeenCalledExactlyOnceWith('[notification] clear response failed:', error)
    expect(connection.pendingFocus).toEqual({ origin, sessionId: 'session', title: 'Response complete', tag: 'dsh-notification-session-1' })
  })
})
