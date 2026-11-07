// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationAction } from './use-notification-action'
import { useNotificationClicked } from './use-notification-clicked'

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke, transformCallback: () => 42 })
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each([
  { name: 'action', event: 'actionPerformed', useNotification: useNotificationAction },
  { name: 'click', event: 'notificationClicked', useNotification: useNotificationClicked },
])('$name notifications', ({ event, useNotification }) => {
  it.each([false, undefined])('does not contact the native plugin when availability is %s', async (available) => {
    vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', available)
    const handler = vi.fn()
    const view = renderHook(() => useNotification(handler))
    await act(async () => {})
    view.unmount()
    expect(invoke).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('registers and disposes the native listener when enabled', async () => {
    vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', true)
    const view = renderHook(() => useNotification(vi.fn()))
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('plugin:notifications|register_listener', { event, handler: expect.anything() }, undefined)
    view.unmount()
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('plugin:notifications|remove_listener', { event, channelId: 42 }, undefined)
  })

  it('delivers native payloads to the current handler without registering again', async () => {
    vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', true)
    const transformCallback = vi.fn((_callback: (message: { index: number, message: unknown }) => void) => 42)
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke, transformCallback })
    const oldHandler = vi.fn()
    const currentHandler = vi.fn()
    const view = renderHook(({ handler }) => useNotification(handler), { initialProps: { handler: oldHandler } })
    await act(async () => {})
    view.rerender({ handler: currentHandler })
    const payload = { id: 7, actionId: 'reply', data: { sessionId: 'session-1' } }
    act(() => transformCallback.mock.calls[0][0]({ index: 0, message: payload }))
    expect(oldHandler).not.toHaveBeenCalled()
    expect(currentHandler).toHaveBeenCalledExactlyOnceWith(payload)
    expect(invoke.mock.calls.filter(([command]) => command === 'plugin:notifications|register_listener')).toHaveLength(1)
  })

  it('reports unexpected native registration failures when enabled', async () => {
    vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', true)
    const failure = new Error('native transport failed')
    invoke.mockRejectedValue(failure)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderHook(() => useNotification(vi.fn()))
    await act(async () => {})
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('failed to subscribe'), failure)
  })

  it('disposes a native listener that finishes registering after unmount', async () => {
    vi.stubGlobal('__DSH_NOTIFICATIONS_AVAILABLE__', true)
    const registration = Promise.withResolvers<unknown>()
    invoke.mockImplementationOnce(() => registration.promise)
    const view = renderHook(() => useNotification(vi.fn()))
    expect(invoke).toHaveBeenCalledWith('plugin:notifications|register_listener', { event, handler: expect.anything() }, undefined)
    view.unmount()
    await act(async () => registration.resolve(undefined))
    expect(invoke).toHaveBeenCalledWith('plugin:notifications|remove_listener', { event, channelId: 42 }, undefined)
  })
})
