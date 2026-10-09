// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOmitIgnoreCursorEvents } from './use-omit-ignore-cursor-events'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  position: vi.fn(),
  visible: vi.fn(),
  moved: vi.fn(),
  resized: vi.fn(),
  label: 'pet',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: native.label,
    innerPosition: native.position,
    isVisible: native.visible,
    onMoved: native.moved,
    onResized: native.resized,
  }),
}))

const handlers = new Map<string, (event: { payload: unknown }) => void>()
const disposers: Array<ReturnType<typeof vi.fn>> = []
let element: HTMLDivElement

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function subscribe(name: string, handler: (event: { payload: unknown }) => void) {
  handlers.set(name, handler)
  const dispose = vi.fn(() => {
    handlers.delete(name)
  })
  disposers.push(dispose)
  return Promise.resolve(dispose)
}

async function flush() {
  await act(async () => {})
}

async function emit(name: string, payload: unknown) {
  const handler = handlers.get(name)
  if (handler === undefined)
    throw new Error(`Missing listener: ${name}`)
  await act(async () => {
    handler({ payload })
  })
}

function requests(): boolean[] {
  return native.invoke.mock.calls
    .filter(([command]) => command === 'set_pet_ignore_cursor_events')
    .map(([, args]) => args.ignore)
}

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  disposers.length = 0
  native.label = 'pet'
  native.position.mockResolvedValue({ x: 100, y: 100 })
  native.visible.mockResolvedValue(true)
  native.moved.mockImplementation(handler => subscribe('moved', handler))
  native.resized.mockImplementation(handler => subscribe('resized', handler))
  native.listen.mockImplementation(subscribe)
  native.invoke.mockImplementation((command, args) => Promise.resolve(command === 'set_pet_ignore_cursor_events' ? args.ignore : undefined))
  element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 100, 100))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pet cursor input lifecycle', () => {
  it('applies outside and inside hit tests without duplicate native writes', async () => {
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    await emit('device-mouse-move', { x: 501, y: 501 })
    await emit('device-mouse-move', { x: 120, y: 120 })
    expect(requests()).toEqual([true, false])
  })

  it('keeps dragging interactive and restores the last cursor hit test on release', async () => {
    const ref = { current: element }
    const { rerender } = renderHook(({ dragging }) => useOmitIgnoreCursorEvents(ref, dragging), { initialProps: { dragging: false } })
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    rerender({ dragging: true })
    await flush()
    await emit('device-mouse-move', { x: 600, y: 600 })
    rerender({ dragging: false })
    await flush()
    expect(requests()).toEqual([true, false, true])
  })

  it('applies the first cursor sample once the initial window position arrives', async () => {
    const position = deferred<{ x: number, y: number }>()
    native.position.mockReturnValue(position.promise)
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    expect(requests()).toEqual([])
    await act(async () => {
      position.resolve({ x: 100, y: 100 })
    })
    expect(requests()).toEqual([true])
  })

  it('retests a stationary cursor when the window moves away and back', async () => {
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 120, y: 120 })
    expect(requests()).toEqual([])
    native.position.mockResolvedValue({ x: 400, y: 400 })
    await emit('moved', {})
    expect(requests()).toEqual([true])
    native.position.mockResolvedValue({ x: 100, y: 100 })
    await emit('moved', {})
    expect(requests()).toEqual([true, false])
  })

  it('retests a stationary cursor after resizing the hitbox', async () => {
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 250, y: 150 })
    vi.mocked(element.getBoundingClientRect).mockReturnValue(new DOMRect(10, 10, 200, 100))
    await emit('resized', {})
    expect(requests()).toEqual([true, false])
  })

  it('serializes native writes and applies the newest hit test after an in-flight write', async () => {
    const pending = deferred<boolean>()
    native.invoke.mockImplementation((command, args) => command === 'set_pet_ignore_cursor_events' && args.ignore ? pending.promise : Promise.resolve(false))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    await emit('device-mouse-move', { x: 120, y: 120 })
    expect(requests()).toEqual([true])
    await act(async () => {
      pending.resolve(true)
    })
    expect(requests()).toEqual([true, false])
  })

  it('retries a rejected native write on the next sample instead of caching success', async () => {
    native.invoke.mockImplementationOnce(() => Promise.resolve(undefined))
    native.invoke.mockImplementationOnce(() => Promise.reject(new Error('IPC unavailable')))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    await emit('device-mouse-move', { x: 501, y: 501 })
    expect(requests()).toEqual([true, true])
  })

  it('starts the device stream only after all event listeners are registered', async () => {
    const pending = deferred<() => void>()
    native.listen.mockImplementation((name, handler) => name === 'device-mouse-move' ? pending.promise : subscribe(name, handler))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    expect(native.invoke).not.toHaveBeenCalledWith('start_pet_mouse_stream')
    await act(async () => {
      pending.resolve(vi.fn())
    })
    expect(native.invoke).toHaveBeenCalledWith('start_pet_mouse_stream')
  })

  it('unsubscribes successful listeners even when another registration fails', async () => {
    native.resized.mockRejectedValue(new Error('registration failed'))
    const { unmount } = renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    unmount()
    expect(disposers).toHaveLength(3)
    for (const dispose of disposers)
      expect(dispose).toHaveBeenCalledOnce()
    expect(handlers.size).toBe(0)
  })

  it.each(['moved', 'resized', 'pet://status', 'device-mouse-move'])('starts the stream when the %s listener fails', async (event) => {
    const error = new Error(`${event} registration failed`)
    if (event === 'moved')
      native.moved.mockRejectedValue(error)
    else if (event === 'resized')
      native.resized.mockRejectedValue(error)
    else
      native.listen.mockImplementation((name, handler) => name === event ? Promise.reject(error) : subscribe(name, handler))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('start_pet_mouse_stream')
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[pet] PET_INPUT_LISTEN_FAILED:', error)
  })

  it('waits for remaining subscriptions after failures and reports each failure', async () => {
    const pending = deferred<() => void>()
    const movedError = new Error('moved registration failed')
    const resizedError = new Error('resized registration failed')
    native.moved.mockRejectedValue(movedError)
    native.resized.mockRejectedValue(resizedError)
    native.listen.mockImplementation((name, handler) => name === 'device-mouse-move' ? pending.promise : subscribe(name, handler))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    expect(native.invoke).not.toHaveBeenCalledWith('start_pet_mouse_stream')
    await act(async () => {
      pending.resolve(vi.fn())
    })
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('start_pet_mouse_stream')
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith('[pet] PET_INPUT_LISTEN_FAILED:', movedError)
    expect(console.warn).toHaveBeenCalledWith('[pet] PET_INPUT_LISTEN_FAILED:', resizedError)
  })

  it('reports stream startup failures separately from subscription failures', async () => {
    const error = new Error('stream startup failed')
    native.invoke.mockRejectedValue(error)
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[pet] PET_INPUT_STREAM_FAILED:', error)
  })

  it.each([false, true])('does not start the stream after unmount with failed registration: %s', async (failed) => {
    const pending = deferred<() => void>()
    if (failed)
      native.resized.mockRejectedValue(new Error('registration failed'))
    native.listen.mockImplementation((name, handler) => name === 'device-mouse-move' ? pending.promise : subscribe(name, handler))
    const { unmount } = renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    unmount()
    const dispose = vi.fn()
    await act(async () => {
      pending.resolve(dispose)
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(native.invoke).not.toHaveBeenCalledWith('start_pet_mouse_stream')
  })

  it('restores input after hiding while a click-through write is pending', async () => {
    const pending = deferred<boolean>()
    native.invoke.mockImplementation((command, args) => command === 'set_pet_ignore_cursor_events' && args.ignore ? pending.promise : Promise.resolve(false))
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 500, y: 500 })
    await emit('pet://status', { visible: false })
    expect(requests()).toEqual([true])
    await act(async () => {
      pending.resolve(true)
    })
    expect(requests()).toEqual([true, false])
    await emit('device-mouse-move', { x: 600, y: 600 })
    expect(requests()).toEqual([true, false])
  })

  it('ignores a stale initial visibility reply after a newer status event', async () => {
    const pending = deferred<boolean>()
    native.visible.mockReturnValue(pending.promise)
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('pet://status', { visible: true })
    await emit('device-mouse-move', { x: 500, y: 500 })
    await act(async () => {
      pending.resolve(false)
    })
    expect(requests()).toEqual([true])
  })

  it('passes clicks through an empty pet window', async () => {
    renderHook(() => useOmitIgnoreCursorEvents({ current: null }))
    await flush()
    await emit('device-mouse-move', { x: 120, y: 120 })
    expect(requests()).toEqual([true])
  })

  it('uses physical screen coordinates for a scaled hitbox', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    await emit('device-mouse-move', { x: 400, y: 400 })
    await emit('device-mouse-move', { x: 300, y: 300 })
    expect(requests()).toEqual([true, false])
  })

  it('does not bind pet input handling to the main window', async () => {
    native.label = 'main'
    renderHook(() => useOmitIgnoreCursorEvents({ current: element }))
    await flush()
    expect(native.listen).not.toHaveBeenCalled()
    expect(native.invoke).not.toHaveBeenCalled()
  })
})
