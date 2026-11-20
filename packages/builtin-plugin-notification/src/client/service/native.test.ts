import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let showNativeNotification: typeof import('./native').showNativeNotification
let closeNativeNotifications: typeof import('./native').closeNativeNotifications

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => true),
  clicked: null as null | ((event: { payload: Record<string, string | undefined> }) => void),
  listen: vi.fn(async (_event: string, handler: (event: { payload: Record<string, string | undefined> }) => void) => {
    mocks.clicked = handler
    return () => {}
  }),
}))

vi.mock('dsh-tauri/client', async () => ({
  isNativeNotificationAvailable: (await import('../../../../builtin-plugin-tauri/src/client/service/tauri')).isNativeNotificationAvailable,
  getCurrentWindow: () => ({ label: 'window-2' }),
  invoke: mocks.invoke,
  listen: mocks.listen,
}))

beforeEach(async () => {
  vi.resetModules()
  ;({ showNativeNotification, closeNativeNotifications } = await import('./native'))
  mocks.clicked = null
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:3081' })
  vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', true)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, undefined])('declines native delivery before any IPC when availability is %s', async (available) => {
  vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', available)
  expect(await showNativeNotification({ title: 'Finished', body: 'Turn complete', tag: 'unavailable', sessionId: 'session-1', actions: [{ id: 'approve', title: 'Approve' }] })).toBe(false)
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(mocks.listen).not.toHaveBeenCalled()
})

it('rejects an old action when the same tag now refers to a different interaction', async () => {
  const oldAction = vi.fn()
  const currentAction = vi.fn()
  const input = { title: 'Approval', body: 'Approve?', tag: 'reused-tag', sessionId: 'session-1' }
  await showNativeNotification({ ...input, deliveryKey: 'interaction-old', onAction: oldAction })
  await showNativeNotification({ ...input, deliveryKey: 'interaction-current', onAction: currentAction })
  const payload = { sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081', tag: 'reused-tag', action: 'approve' }
  mocks.clicked!({ payload: { ...payload, deliveryKey: JSON.stringify([payload.sourceOrigin, 'interaction-old']) } })
  mocks.clicked!({ payload })
  expect(oldAction).not.toHaveBeenCalled()
  mocks.clicked!({ payload: { ...payload, sessionId: 'other-session', deliveryKey: JSON.stringify([payload.sourceOrigin, 'interaction-current']) } })
  expect(currentAction).not.toHaveBeenCalled()
  mocks.clicked!({ payload: { ...payload, deliveryKey: JSON.stringify([payload.sourceOrigin, 'interaction-current']), inputValue: 'current reply' } })
  expect(currentAction).toHaveBeenCalledExactlyOnceWith('approve', 'current reply')
})

it('closes a delivered notification with the same id it was sent under', async () => {
  await showNativeNotification({ title: 'Finished', body: 'Turn complete', tag: 'turn-1', sessionId: 'session-1' })
  const calls = mocks.invoke.mock.calls as unknown as [string, { options: { id: number } }][]
  const deliveredId = calls.find(([command]) => command === 'plugin:notifications|notify')?.[1].options.id
  expect(deliveredId).toBeTypeOf('number')
  await closeNativeNotifications(['turn-1'])
  expect(mocks.invoke).toHaveBeenCalledWith('plugin:notifications|remove_active', { notifications: [{ id: deliveredId }] })
})

it('skips the close IPC when native notifications are unavailable', async () => {
  vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', false)
  await closeNativeNotifications(['turn-1'])
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('drops the action handler once its notification is closed', async () => {
  const onAction = vi.fn()
  await showNativeNotification({ title: 'Approval', body: 'Approve?', tag: 'approval-1', sessionId: 'session-1', deliveryKey: 'interaction-1', onAction })
  await closeNativeNotifications(['approval-1'])
  mocks.clicked!({ payload: { sessionId: 'session-1', sourceOrigin: 'http://127.0.0.1:3081', tag: 'approval-1', action: 'approve', deliveryKey: JSON.stringify(['http://127.0.0.1:3081', 'interaction-1']) } })
  expect(onAction).not.toHaveBeenCalled()
})

it('stores the producing window and session in the native activation payload', async () => {
  expect(await showNativeNotification({ title: 'Finished', body: 'Turn complete', tag: 'turn-1', sessionId: 'session-1', deliveryKey: 'session-1:turn:42' })).toBe(true)
  await vi.waitFor(() => {
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:notifications|notify', {
      options: expect.objectContaining({
        title: 'Finished',
        extra: { sessionId: 'session-1', title: 'Finished', tag: 'turn-1', windowLabel: 'window-2', sourceOrigin: 'http://127.0.0.1:3081', deliveryKey: JSON.stringify(['http://127.0.0.1:3081', 'session-1:turn:42']) },
      }),
    })
  })
})
