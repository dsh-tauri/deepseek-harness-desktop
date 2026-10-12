import type { RefObject } from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Iframe } from './iframe'

const mocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<NotificationPermission>>(),
  registerActionTypes: vi.fn(),
  sendNotification: vi.fn(),
  invoke: vi.fn(),
  onMessage: undefined as ((data: Record<string, unknown>) => void) | undefined,
}))

vi.mock('@choochmeque/tauri-plugin-notifications-api', () => mocks)
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@reause/core', () => ({
  useEventListener: vi.fn(),
  useWatch: vi.fn(),
  useTimeoutFn: () => ({ start: vi.fn(), stop: vi.fn() }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@/config/client', () => ({ queryClient: {} }))
vi.mock('@/config/query-keys', () => ({ queryKeys: {} }))
vi.mock('@/store', () => ({ store: { harness: { markIframeAlive: vi.fn() }, setting: {} } }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [null, vi.fn()] }))
vi.mock('@/hooks/use-iframe-message', () => ({
  useIframeMessage: (_ref: unknown, handler: typeof mocks.onMessage) => { mocks.onMessage = handler },
}))
vi.mock('@/hooks/use-iframe-post', () => ({ useIframePost: () => vi.fn() }))
vi.mock('@/hooks/use-invoke-iframe', () => ({ useInvokeIframe: vi.fn() }))
vi.mock('@/hooks/use-notification-action', () => ({ useNotificationAction: vi.fn() }))
vi.mock('@/hooks/use-notification-clicked', () => ({ useNotificationClicked: vi.fn() }))
vi.mock('@/hooks/use-sync-visibility', () => ({ useSyncVisibility: vi.fn() }))
vi.mock('@/hooks/use-zoom-factor', () => ({ useZoomFactor: vi.fn() }))
vi.mock('@/hooks/use-appearance', () => ({ useAppearance: () => '' }))
vi.mock('./loadable', () => ({ Loadable: () => null }))

function notify(tag = 'dsh-notification-session-1') {
  if (!mocks.onMessage)
    throw new Error('Iframe message handler was not registered')
  mocks.onMessage({
    type: 'dsh://native-notification',
    title: 'Permission required',
    body: 'Approve the tool',
    sessionId: 'session',
    tag,
    silent: true,
    actions: [{ action: 'approve', title: 'Approve' }],
  })
}

async function settle() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.isPermissionGranted.mockResolvedValue(true)
  mocks.requestPermission.mockResolvedValue('granted')
  mocks.registerActionTypes.mockResolvedValue(undefined)
  mocks.sendNotification.mockResolvedValue(undefined)
  mocks.invoke.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  renderToStaticMarkup(createElement(Iframe, {
    iframeRef: { current: null } as RefObject<HTMLIFrameElement | null>,
  }))
})

afterEach(() => {
  mocks.onMessage = undefined
  delete (globalThis as Record<string, unknown>).document
  vi.restoreAllMocks()
})

describe('iframe native notification authorization', () => {
  it('requests native permission before registering actions or sending the first notification', async () => {
    mocks.isPermissionGranted.mockResolvedValue(false)
    let grant: (value: NotificationPermission) => void = () => {
      throw new Error('Permission request did not start')
    }
    mocks.requestPermission.mockImplementation(() => new Promise((resolve) => {
      grant = resolve
    }))

    notify()
    await settle()
    expect(mocks.isPermissionGranted).toHaveBeenCalledOnce()
    expect(mocks.requestPermission).toHaveBeenCalledOnce()
    expect(mocks.registerActionTypes).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()

    grant('granted')
    await settle()
    expect(mocks.registerActionTypes).toHaveBeenCalledWith([{
      id: 'dsh-notification-approve',
      actions: [{ id: 'approve', title: 'Approve', foreground: true, input: false }],
    }])
    expect(mocks.sendNotification).toHaveBeenCalledWith({
      id: 1525991148,
      title: 'Permission required',
      body: 'Approve the tool',
      silent: true,
      actionTypeId: 'dsh-notification-approve',
      extra: { sessionId: 'session', title: 'Permission required', tag: 'dsh-notification-session-1' },
    })
  })

  it('sends an already authorized notification without requesting permission again', async () => {
    notify()
    await settle()
    expect(mocks.isPermissionGranted).toHaveBeenCalledOnce()
    expect(mocks.requestPermission).not.toHaveBeenCalled()
    expect(mocks.sendNotification).toHaveBeenCalledOnce()
  })

  it.each(['denied', 'default'] as const)('does not send notifications when permission is %s', async (permission) => {
    mocks.isPermissionGranted.mockResolvedValue(false)
    mocks.requestPermission.mockResolvedValue(permission)
    notify()
    await settle()
    expect(mocks.requestPermission).toHaveBeenCalledOnce()
    expect(mocks.registerActionTypes).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it('shares the pending authorization request between concurrent notifications', async () => {
    mocks.isPermissionGranted.mockResolvedValue(false)
    let grant: (value: NotificationPermission) => void = () => {
      throw new Error('Permission request did not start')
    }
    mocks.requestPermission.mockImplementation(() => new Promise((resolve) => {
      grant = resolve
    }))
    notify('first')
    notify('second')
    await settle()
    expect(mocks.isPermissionGranted).toHaveBeenCalledOnce()
    expect(mocks.requestPermission).toHaveBeenCalledOnce()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
    grant('granted')
    await settle()
    expect(mocks.sendNotification.mock.calls.map(([options]) => options.extra.tag)).toEqual(['first', 'second'])
  })

  it.each(['check', 'request'] as const)('logs a failed permission %s without sending and retries the next notification', async (stage) => {
    const error = new Error('Native authorization unavailable')
    if (stage === 'check') {
      mocks.isPermissionGranted.mockRejectedValueOnce(error)
    }
    else {
      mocks.isPermissionGranted.mockResolvedValueOnce(false)
      mocks.requestPermission.mockRejectedValueOnce(error)
    }
    notify()
    await settle()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('[notification] permission request failed:', error)
    notify()
    await settle()
    expect(mocks.isPermissionGranted).toHaveBeenCalledTimes(2)
    expect(mocks.sendNotification).toHaveBeenCalledOnce()
  })

  it('rechecks native permission after the user changes system notification settings', async () => {
    mocks.isPermissionGranted.mockResolvedValueOnce(false)
    mocks.requestPermission.mockResolvedValueOnce('denied')
    notify()
    await settle()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
    notify()
    await settle()
    expect(mocks.isPermissionGranted).toHaveBeenCalledTimes(2)
    expect(mocks.requestPermission).toHaveBeenCalledOnce()
    expect(mocks.sendNotification).toHaveBeenCalledOnce()
  })
})

function dispatched() {
  return mocks.invoke.mock.calls.filter(([command]) => command === 'notify_webhook_dispatch')
}

function setHidden(hidden: boolean) {
  (globalThis as Record<string, unknown>).document = { hidden }
}

describe('iframe notification webhook forwarding', () => {
  it('forwards nothing while the window is in the foreground', async () => {
    notify()
    await settle()

    expect(dispatched()).toEqual([])
    expect(mocks.sendNotification).toHaveBeenCalledOnce()
  })

  it('forwards the notification body once the window is hidden', async () => {
    setHidden(true)

    notify()
    await settle()

    expect(dispatched()).toEqual([['notify_webhook_dispatch', {
      payload: { title: 'Permission required', body: 'Approve the tool', sessionId: 'session' },
    }]])
  })

  it('keeps the local notification even when the webhook call fails', async () => {
    setHidden(true)
    const failure = new Error('NOTIFY_CONNECT: smtp')
    mocks.invoke.mockRejectedValue(failure)

    notify()
    await settle()

    expect(mocks.sendNotification).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith('[notification] webhook dispatch failed:', failure)
  })

  it('stops forwarding once the window regains focus', async () => {
    setHidden(true)
    notify()
    await settle()
    expect(dispatched()).toHaveLength(1)

    setHidden(false)
    notify('second')
    await settle()

    expect(dispatched()).toHaveLength(1)
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2)
  })
})
