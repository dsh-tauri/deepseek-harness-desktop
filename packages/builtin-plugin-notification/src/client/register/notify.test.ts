import type { LifecycleController } from '../../../../builtin-plugin-tauri/src/client/controller'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../builtin-plugin-tauri/src/client/controller'
import { notificationSettings } from '../store'
import { notifyFeature } from './notify'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: { sessionId?: string, action?: string, sourceOrigin?: string } }) => void>(),
  openSession: vi.fn(() => ({ status: 'opened' })),
  emit: vi.fn(async () => {}),
  show: vi.fn(async () => true),
  close: vi.fn(async () => true),
  readTurnEnd: vi.fn(async () => ({ interrupted: false, turn: 42 })),
  play: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (setup: unknown) => setup,
  emit: mocks.emit,
  listen: async (event: string, handler: (event: { payload: { sessionId?: string, action?: string, sourceOrigin?: string } }) => void) => {
    mocks.listeners.set(event, handler)
    return () => mocks.listeners.delete(event)
  },
}))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key } }))
vi.mock('../store', () => ({ notificationSettings: { $state: {} } }))
vi.mock('../service/native', () => ({ showNativeNotification: mocks.show, closeNativeNotifications: mocks.close }))
vi.mock('../service/sound', () => ({ createSoundPlayer: () => ({ play: mocks.play, dispose: vi.fn() }) }))
vi.mock('../service/turn-end', () => ({ readTurnEnd: mocks.readTurnEnd }))

beforeEach(() => vi.stubGlobal('location', { origin: 'http://127.0.0.1:3081' }))

/** 页面的可见性由 document 决定：node 环境没有它，按用例给出可控的替身。 */
function stubDocument(visibilityState: 'hidden' | 'visible') {
  const listeners = new Map<string, EventListener>()
  const document = {
    visibilityState,
    addEventListener: (type: string, handler: EventListener) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  vi.stubGlobal('document', document)
  return { document, listeners }
}

async function deliverTurnNotification(currentSessionId: string, visibilityState: 'hidden' | 'visible' = 'hidden') {
  const { document, listeners } = stubDocument(visibilityState)
  Object.assign(notificationSettings.$state, { turnComplete: 'always', sound: 'default' })
  const observers = new Set<() => void>()
  let running = true
  const sessions = { list: {
    getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { id: 'session-1', running, updatedAt: 100 } } }),
    subscribe: (fn: () => void) => {
      observers.add(fn)
      return () => observers.delete(fn)
    },
  } }
  const controller = createLifecycleController()
  const setup = notifyFeature as unknown as (controller: LifecycleController, ctx: unknown, adapter: unknown) => void
  setup(controller, { get: (name: string) => name === 'sessions' ? sessions : undefined }, { has: () => false, sessionList: () => ({ ids: ['session-1'], current: currentSessionId }) })
  running = false
  observers.forEach(fn => fn())
  await vi.waitFor(() => expect(mocks.play).toHaveBeenCalledOnce())
  return { controller, document, listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.listeners.clear()
  vi.clearAllMocks()
})

it('opens a session from a historical notification before creating any new notification', async () => {
  const controller = createLifecycleController()
  const setup = notifyFeature as unknown as (controller: LifecycleController, ctx: unknown, adapter: unknown) => void
  setup(controller, { get: () => undefined }, { has: () => false, openSession: mocks.openSession })
  await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledWith('dsh://notification-ready', { sourceOrigin: 'http://127.0.0.1:3081' }))
  try {
    mocks.emit.mockClear()
    mocks.listeners.get('dsh://notification-ready-request')!({ payload: {} })
    expect(mocks.emit).toHaveBeenCalledWith('dsh://notification-ready', { sourceOrigin: 'http://127.0.0.1:3081' })
    const clicked = mocks.listeners.get('dsh://notification-clicked')!
    clicked({ payload: { sessionId: 'session-before-reload', sourceOrigin: 'http://127.0.0.1:3081' } })
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith('session-before-reload')
    clicked({ payload: { sessionId: 'session-before-reload', sourceOrigin: 'http://127.0.0.1:3081', action: 'approve' } })
    clicked({ payload: { sessionId: '' } })
    clicked({ payload: { sessionId: 'wrong-host', sourceOrigin: 'https://other.test' } })
    expect(mocks.openSession).toHaveBeenCalledTimes(1)
  }
  finally {
    controller.dispose()
  }
  expect(mocks.listeners.size).toBe(0)
})

it('gives two guest producers the same turn identity and plays sound only for the accepted delivery', async () => {
  vi.useFakeTimers()
  Object.assign(notificationSettings.$state, { turnComplete: 'always', sound: 'default' })
  const observers = new Set<() => void>()
  let running = true
  const sessions = { list: {
    getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { id: 'session-1', running, updatedAt: 100 } } }),
    subscribe: (fn: () => void) => {
      observers.add(fn)
      return () => observers.delete(fn)
    },
  } }
  const controllers = [createLifecycleController(), createLifecycleController()]
  const setup = notifyFeature as unknown as (controller: LifecycleController, ctx: unknown, adapter: unknown) => void
  mocks.show.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  try {
    for (const controller of controllers)
      setup(controller, { get: (name: string) => name === 'sessions' ? sessions : undefined }, { has: () => false, sessionList: () => undefined })
    running = false
    observers.forEach(fn => fn())
    await vi.advanceTimersByTimeAsync(250)
    expect(mocks.show).toHaveBeenCalledTimes(2)
    for (const [input] of mocks.show.mock.calls as unknown as [{ deliveryKey: string }][])
      expect(input.deliveryKey).toBe(JSON.stringify(['session-1', 'turn', 42]))
    expect(mocks.play).toHaveBeenCalledOnce()
    expect(mocks.readTurnEnd).toHaveBeenCalledTimes(2)
  }
  finally {
    controllers.forEach(controller => controller.dispose())
    vi.useRealTimers()
  }
})

it('closes the notification of the session the user comes back to', async () => {
  const { controller, document, listeners } = await deliverTurnNotification('session-1')
  try {
    document.visibilityState = 'visible'
    listeners.get('visibilitychange')!({} as Event)
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith(['dsh-notification-session-1-1']))
  }
  finally {
    controller.dispose()
  }
})

it('keeps the notification of a session the user did not open', async () => {
  const { controller, document, listeners } = await deliverTurnNotification('session-2')
  try {
    document.visibilityState = 'visible'
    listeners.get('visibilitychange')!({} as Event)
    expect(mocks.close).not.toHaveBeenCalled()
  }
  finally {
    controller.dispose()
  }
})

it('keeps the notification while the window stays in the background', async () => {
  const { controller, listeners } = await deliverTurnNotification('session-1')
  try {
    listeners.get('visibilitychange')!({} as Event)
    expect(mocks.close).not.toHaveBeenCalled()
  }
  finally {
    controller.dispose()
  }
})

it('closes a notification that arrives while the user is already viewing that session', async () => {
  const { controller } = await deliverTurnNotification('session-1', 'visible')
  try {
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith(['dsh-notification-session-1-1']))
  }
  finally {
    controller.dispose()
  }
})

it('retries closing on the next return when the bridge rejects the close', async () => {
  mocks.close.mockResolvedValueOnce(false)
  const { controller, document, listeners } = await deliverTurnNotification('session-1')
  try {
    document.visibilityState = 'visible'
    listeners.get('visibilitychange')!({} as Event)
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1))
    listeners.get('visibilitychange')!({} as Event)
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(2))
    expect(mocks.close).toHaveBeenLastCalledWith(['dsh-notification-session-1-1'])
  }
  finally {
    controller.dispose()
  }
})
