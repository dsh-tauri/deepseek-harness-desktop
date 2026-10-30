import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleController } from './index'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createLifecycleController', () => {
  it('cancels only the selected registration and disposes the rest once in order', () => {
    const controller = createLifecycleController()
    const calls: string[] = []
    const duplicate = () => calls.push('duplicate')
    const cancel = controller.add(duplicate)
    controller.add(() => calls.push('middle'))
    controller.add(duplicate)
    cancel()
    cancel()

    expect(controller.isDisposed()).toBe(false)
    expect(calls).toEqual([])
    controller.dispose()
    controller.dispose()
    controller.add(() => calls.push('late'))()
    expect(controller.isDisposed()).toBe(true)
    expect(calls).toEqual(['middle', 'duplicate'])
  })

  it('removes window listeners on explicit and controller disposal', () => {
    const controller = createLifecycleController()
    const windowListeners = new Map<string, EventListener>()
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => windowListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string, _listener: EventListener) => windowListeners.delete(type)),
    })
    const handler = vi.fn()
    const remove = controller.listenWindow('resize', handler)

    expect(windowListeners.has('resize')).toBe(true)
    remove()
    expect(windowListeners.has('resize')).toBe(false)
    expect(window.removeEventListener).toHaveBeenCalledTimes(1)

    controller.listenWindow('resize', handler)
    controller.dispose()
    expect(windowListeners.has('resize')).toBe(false)
    expect(window.removeEventListener).toHaveBeenCalledTimes(2)
  })

  it('continues cleanup after a disposer throws', () => {
    const controller = createLifecycleController()
    const error = new Error('cleanup failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const next = vi.fn()
    controller.add(() => {
      throw error
    })
    controller.add(next)

    controller.dispose()
    expect(log).toHaveBeenCalledExactlyOnceWith('[LifecycleController] Unhandled exception in disposer:', error)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('disposes the starting snapshot even when cleanup unregisters another disposer', () => {
    const controller = createLifecycleController()
    const calls: string[] = []
    let cancel = () => {}
    controller.add(() => {
      calls.push('first')
      cancel()
      controller.dispose()
      controller.add(() => calls.push('late'))
    })
    cancel = controller.add(() => calls.push('second'))

    controller.dispose()
    expect(calls).toEqual(['first', 'second'])
  })
})
