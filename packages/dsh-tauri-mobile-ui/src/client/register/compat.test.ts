// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (setup: (controller: { add: (dispose: () => void) => void }) => void) => () => {
    const cleanups: Array<() => void> = []
    setup({ add: dispose => cleanups.push(dispose) })
    return () => cleanups.splice(0).reverse().forEach(dispose => dispose())
  },
}))

const native = Object.getOwnPropertyDescriptor(Promise, 'withResolvers')

function withoutWithResolvers(): void {
  delete (Promise as Partial<typeof Promise>).withResolvers
}

beforeEach(() => {
  vi.resetModules()
  withoutWithResolvers()
})

afterEach(() => {
  if (native)
    Object.defineProperty(Promise, 'withResolvers', native)
  else
    withoutWithResolvers()
  vi.restoreAllMocks()
})

describe('promise-with-resolvers kernel compatibility', () => {
  it('installs the shim during module evaluation when the kernel lacks it', async () => {
    expect(typeof Promise.withResolvers).toBe('undefined')
    await import('./compat')
    expect(typeof Promise.withResolvers).toBe('function')
  })

  it('constructs a session reference the way the Session controller does once the shim is installed', async () => {
    await import('./compat')
    class ClientSessionReference {
      readiness = Promise.withResolvers<string>()
      ready = this.readiness.promise
    }
    const reference = new ClientSessionReference()
    reference.readiness.resolve('bound')
    await expect(reference.ready).resolves.toBe('bound')
  })

  it('returns independent promise, resolve and reject handles per call', async () => {
    await import('./compat')
    const first = Promise.withResolvers<number>()
    const second = Promise.withResolvers<number>()
    expect(first.promise).not.toBe(second.promise)
    first.resolve(1)
    second.reject(new Error('second'))
    await expect(first.promise).resolves.toBe(1)
    await expect(second.promise).rejects.toThrow('second')
  })

  it('keeps a native implementation untouched', async () => {
    const browserNative = vi.fn(() => ({ promise: Promise.resolve(), resolve: vi.fn(), reject: vi.fn() }))
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: browserNative })
    const compat = await import('./compat')
    compat.registerPromiseWithResolvers()
    expect(Promise.withResolvers).toBe(browserNative)
  })

  it('removes only its own shim on disposal', async () => {
    const compat = await import('./compat')
    const dispose = compat.registerCompat()
    expect(typeof Promise.withResolvers).toBe('function')
    dispose()
    expect(typeof Promise.withResolvers).toBe('undefined')
  })

  it('preserves an implementation another owner installs after registration', async () => {
    const compat = await import('./compat')
    const dispose = compat.registerCompat()
    const later = vi.fn()
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: later })
    dispose()
    expect(Promise.withResolvers).toBe(later)
  })

  it('reinstalls after disposal without resetting the module', async () => {
    const compat = await import('./compat')
    const firstDispose = compat.registerCompat()
    firstDispose()
    expect(typeof Promise.withResolvers).toBe('undefined')
    const secondDispose = compat.registerCompat()
    expect(typeof Promise.withResolvers).toBe('function')
    secondDispose()
    expect(typeof Promise.withResolvers).toBe('undefined')
  })
})
