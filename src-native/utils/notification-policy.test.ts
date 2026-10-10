import type { NativeNotificationMessage, NotificationAdapter } from './notification-policy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNotificationDispatcher, createResponseCoalescer, notificationIdFor } from './notification-policy'

const origin = 'https://harness.test:3080'
const notification: NativeNotificationMessage = {
  type: 'dsh://native-notification',
  title: 'Response complete',
  body: 'Your answer is ready',
  sessionId: 'session',
  tag: 'dsh-notification-session-1',
  silent: false,
}

function createAdapter() {
  return {
    isForeground: vi.fn<NotificationAdapter['isForeground']>(() => false),
    checkPermission: vi.fn<NotificationAdapter['checkPermission']>().mockResolvedValue(false),
    requestPermission: vi.fn<NotificationAdapter['requestPermission']>().mockResolvedValue(true),
    deliver: vi.fn<NotificationAdapter['deliver']>().mockResolvedValue(undefined),
    reportError: vi.fn<NotificationAdapter['reportError']>(),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('notificationIdFor', () => {
  it('returns the stable native identifier for a session notification tag', () => {
    expect(notificationIdFor('dsh-notification-session-1')).toBe('1525991148')
  })

  it('leaves an empty tag without a native identifier', () => {
    expect(notificationIdFor('')).toBeUndefined()
  })

  it('replaces a zero hash with a nonzero identifier', () => {
    expect(notificationIdFor('\u0000')).toBe('1')
  })
})

describe('createNotificationDispatcher', () => {
  it('drops foreground notifications before checking permission', async () => {
    const adapter = createAdapter()
    adapter.isForeground.mockReturnValue(true)
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).not.toHaveBeenCalled()
    expect(adapter.requestPermission).not.toHaveBeenCalled()
    expect(adapter.deliver).not.toHaveBeenCalled()
    expect(adapter.reportError).not.toHaveBeenCalled()
  })

  it('checks permission before requesting it and delivers only after approval', async () => {
    const adapter = createAdapter()
    const order: string[] = []
    adapter.checkPermission.mockImplementation(async () => {
      order.push('check')
      return false
    })
    adapter.requestPermission.mockImplementation(async () => {
      order.push('request')
      return true
    })
    adapter.deliver.mockImplementation(async () => {
      order.push('deliver')
    })
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)

    expect(order).toEqual(['check', 'request', 'deliver'])
    expect(adapter.checkPermission).toHaveBeenCalledExactlyOnceWith()
    expect(adapter.requestPermission).toHaveBeenCalledExactlyOnceWith()
    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith(notification, origin, '1525991148')
  })

  it('delivers already-granted notifications without another permission request', async () => {
    const adapter = createAdapter()
    adapter.checkPermission.mockResolvedValue(true)
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).toHaveBeenCalledExactlyOnceWith()
    expect(adapter.requestPermission).not.toHaveBeenCalled()
    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith(notification, origin, '1525991148')
  })

  it('does not deliver when the permission request is denied', async () => {
    const adapter = createAdapter()
    adapter.requestPermission.mockResolvedValue(false)
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).toHaveBeenCalledExactlyOnceWith()
    expect(adapter.requestPermission).toHaveBeenCalledExactlyOnceWith()
    expect(adapter.deliver).not.toHaveBeenCalled()
    expect(adapter.reportError).not.toHaveBeenCalled()
  })

  it('shares one in-flight check and request across concurrent callers', async () => {
    const adapter = createAdapter()
    const check = Promise.withResolvers<boolean>()
    const request = Promise.withResolvers<boolean>()
    const requestStarted = Promise.withResolvers<void>()
    adapter.checkPermission.mockReturnValue(check.promise)
    adapter.requestPermission.mockImplementation(() => {
      requestStarted.resolve()
      return request.promise
    })
    const dispatcher = createNotificationDispatcher(adapter)

    const first = dispatcher.notify(notification, origin)
    const second = dispatcher.notify(notification, origin)
    const permission = dispatcher.ensurePermission()
    expect(dispatcher.ensurePermission()).toBe(permission)
    expect(adapter.checkPermission).toHaveBeenCalledTimes(1)
    expect(adapter.requestPermission).not.toHaveBeenCalled()
    expect(adapter.deliver).not.toHaveBeenCalled()

    check.resolve(false)
    await requestStarted.promise
    const third = dispatcher.notify(notification, origin)
    expect(adapter.checkPermission).toHaveBeenCalledTimes(1)
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(adapter.deliver).not.toHaveBeenCalled()

    request.resolve(true)
    await expect(permission).resolves.toBe(true)
    await Promise.all([first, second, third])

    expect(adapter.deliver.mock.calls).toEqual([
      [notification, origin, '1525991148'],
      [notification, origin, '1525991148'],
      [notification, origin, '1525991148'],
    ])
    expect(adapter.reportError).not.toHaveBeenCalled()
  })

  it('drops a notification when the app becomes foreground during permission checking', async () => {
    const adapter = createAdapter()
    const check = Promise.withResolvers<boolean>()
    adapter.checkPermission.mockReturnValue(check.promise)
    const dispatcher = createNotificationDispatcher(adapter)

    const pending = dispatcher.notify(notification, origin)
    expect(adapter.deliver).not.toHaveBeenCalled()
    adapter.isForeground.mockReturnValue(true)
    check.resolve(true)
    await pending

    expect(adapter.isForeground).toHaveBeenCalledTimes(2)
    expect(adapter.requestPermission).not.toHaveBeenCalled()
    expect(adapter.deliver).not.toHaveBeenCalled()
  })

  it.each(['checkPermission', 'requestPermission'] as const)('logs %s failure and retries on the next notification', async (operation) => {
    const adapter = createAdapter()
    const error = new Error(`${operation} failed`)
    adapter[operation].mockRejectedValueOnce(error)
    const dispatcher = createNotificationDispatcher(adapter)

    await expect(dispatcher.notify(notification, origin)).resolves.toBeUndefined()

    expect(adapter.reportError).toHaveBeenCalledExactlyOnceWith('[notification] permission request failed:', error)
    expect(adapter.deliver).not.toHaveBeenCalled()

    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).toHaveBeenCalledTimes(2)
    expect(adapter.requestPermission).toHaveBeenCalledTimes(operation === 'checkPermission' ? 1 : 2)
    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith(notification, origin, '1525991148')
    expect(adapter.reportError).toHaveBeenCalledTimes(1)
  })

  it('rechecks permission after a settings grant rather than caching denial', async () => {
    const adapter = createAdapter()
    adapter.checkPermission.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    adapter.requestPermission.mockResolvedValue(false)
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)
    expect(adapter.deliver).not.toHaveBeenCalled()
    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).toHaveBeenCalledTimes(2)
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith(notification, origin, '1525991148')
  })

  it('rechecks permission after a settings revocation rather than caching approval', async () => {
    const adapter = createAdapter()
    adapter.checkPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    adapter.requestPermission.mockResolvedValue(false)
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify(notification, origin)
    await dispatcher.notify(notification, origin)

    expect(adapter.checkPermission).toHaveBeenCalledTimes(2)
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith(notification, origin, '1525991148')
  })

  it.each([false, true])('preserves notification metadata and silent=%s when delivering', async (silent) => {
    const adapter = createAdapter()
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify({ ...notification, silent }, origin)

    expect(adapter.deliver.mock.calls).toEqual([[
      {
        type: 'dsh://native-notification',
        title: 'Response complete',
        body: 'Your answer is ready',
        sessionId: 'session',
        tag: 'dsh-notification-session-1',
        silent,
      },
      'https://harness.test:3080',
      '1525991148',
    ]])
  })

  it('delivers an untagged notification without manufacturing an identifier', async () => {
    const adapter = createAdapter()
    const dispatcher = createNotificationDispatcher(adapter)

    await dispatcher.notify({ ...notification, tag: '' }, origin)

    expect(adapter.deliver).toHaveBeenCalledExactlyOnceWith({ ...notification, tag: '' }, origin, undefined)
  })

  it('logs a delivery failure without preventing the next delivery', async () => {
    const adapter = createAdapter()
    const error = new Error('native delivery failed')
    adapter.deliver.mockRejectedValueOnce(error)
    const dispatcher = createNotificationDispatcher(adapter)

    await expect(dispatcher.notify(notification, origin)).resolves.toBeUndefined()
    expect(adapter.reportError).toHaveBeenCalledExactlyOnceWith('[notification] send failed:', error)

    await dispatcher.notify(notification, origin)

    expect(adapter.deliver).toHaveBeenCalledTimes(2)
    expect(adapter.checkPermission).toHaveBeenCalledTimes(2)
    expect(adapter.reportError).toHaveBeenCalledTimes(1)
  })
})

describe('createResponseCoalescer', () => {
  it('rejects repeated responses through 249ms and accepts them at exactly 250ms', () => {
    const accept = createResponseCoalescer()

    expect(accept('response', 0)).toBe(true)
    expect(accept('response', 0)).toBe(false)
    expect(accept('response', 249)).toBe(false)
    expect(accept('response', 250)).toBe(true)
    expect(accept('response', 499)).toBe(false)
    expect(accept('response', 500)).toBe(true)
  })

  it('does not extend the coalescing window when a duplicate is rejected', () => {
    const accept = createResponseCoalescer()

    expect(accept('response', 1000)).toBe(true)
    expect(accept('response', 1249)).toBe(false)
    expect(accept('response', 1250)).toBe(true)
  })

  it('coalesces independent response keys separately, including the empty key', () => {
    const accept = createResponseCoalescer()

    expect(accept('first', 1000)).toBe(true)
    expect(accept('second', 1000)).toBe(true)
    expect(accept('', 1000)).toBe(true)
    expect(accept('first', 1001)).toBe(false)
    expect(accept('second', 1001)).toBe(false)
    expect(accept('', 1001)).toBe(false)
  })

  it('uses the controlled clock when no explicit timestamp is supplied', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const accept = createResponseCoalescer()

    expect(accept('response')).toBe(true)
    vi.advanceTimersByTime(249)
    expect(accept('response')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(accept('response')).toBe(true)
  })

  it('honors a custom coalescing window', () => {
    const accept = createResponseCoalescer(10)

    expect(accept('response', 0)).toBe(true)
    expect(accept('response', 9)).toBe(false)
    expect(accept('response', 10)).toBe(true)
  })

  it('accepts simultaneous duplicate responses when the window is zero', () => {
    const accept = createResponseCoalescer(0)

    expect(accept('response', 0)).toBe(true)
    expect(accept('response', 0)).toBe(true)
  })

  it('retains 64 keys and evicts the oldest key when a 65th is accepted', () => {
    const accept = createResponseCoalescer()
    for (let index = 0; index < 64; index++)
      expect(accept(`key-${index}`, 1000)).toBe(true)

    expect(accept('key-0', 1000)).toBe(false)
    expect(accept('key-64', 1000)).toBe(true)
    expect(accept('key-1', 1000)).toBe(false)
    expect(accept('key-63', 1000)).toBe(false)
    expect(accept('key-64', 1000)).toBe(false)
    expect(accept('key-0', 1000)).toBe(true)
  })
})
