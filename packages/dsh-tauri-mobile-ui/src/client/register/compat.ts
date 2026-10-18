import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'

interface PromiseResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

let installed = false
let shim: typeof Promise.withResolvers | undefined

/** WebView < Chrome 119 缺 `Promise.withResolvers`：会话控制器构造引用时求值，缺失则点开会话无反应。 */
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
