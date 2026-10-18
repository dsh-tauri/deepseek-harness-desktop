import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'

interface PromiseResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

let installed = false
let shim: typeof Promise.withResolvers | undefined

/**
 * Older WebView kernels (Chrome/116 and below) lack `Promise.withResolvers`, which
 * `@deepseek-ai/dsh-api-session-controller` evaluates while constructing every
 * `ClientSessionReference`. Retaining a Session then throws, so opening a listed
 * Session from the sidebar does nothing on those devices.
 */
export function registerPromiseWithResolvers(): void {
  if (installed)
    return

  installed = true

  if (typeof Promise.withResolvers === 'function')
    return

  const installedShim = function withResolvers<T>(): PromiseResolvers<T> {
    let resolve!: PromiseResolvers<T>['resolve']
    let reject!: PromiseResolvers<T>['reject']
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }
  shim = installedShim

  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: installedShim,
  })
}

function restorePromiseWithResolvers(): void {
  const owned = shim
  shim = undefined
  installed = false

  if (owned !== undefined && Promise.withResolvers === owned)
    delete (Promise as Partial<PromiseConstructor>).withResolvers
}

export const registerCompat = defineRegister<ClientContext>((controller) => {
  registerPromiseWithResolvers()
  controller.add(restorePromiseWithResolvers)
})

// keep:effect the Session controller builds its references before any Cordis effect runs.
registerPromiseWithResolvers()
