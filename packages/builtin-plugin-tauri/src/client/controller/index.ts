import type { Event } from '@tauri-apps/api/event'
import { noop } from '@reause/core'
import { listen } from '../service/tauri'

export interface LifecycleHooks {
  dispose: () => void
}

export interface LifecycleController {
  add: (disposer: () => void) => () => void
  timeout: (fn: () => void, ms: number) => () => void
  interval: (fn: () => void, ms: number) => () => void
  listen: <K extends keyof DocumentEventMap>(
    type: K,
    fn: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => () => void
  listenEvent: <T = unknown>(event: string, fn: (event: Event<T>) => void) => () => void
  listenWindow: <K extends keyof WindowEventMap>(
    type: K,
    fn: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => () => void
  observe: (target: Node, onMutate: MutationCallback, options?: MutationObserverInit) => MutationObserver
  isDisposed: () => boolean
  dispose: () => void
}

const DEFAULT_MUTATION_OPTIONS: MutationObserverInit = { childList: true, subtree: true }

export function createLifecycleController(): LifecycleController {
  let isDisposed = false
  const activeTimeouts = new Set<ReturnType<typeof setTimeout>>()
  const disposers = new Set<LifecycleHooks['dispose']>()
  const controller: LifecycleController = {
    add(disposer) {
      if (isDisposed)
        return noop
      const safeDisposer = () => {
        try {
          disposer()
        }
        catch (error) {
          console.error('[LifecycleController] Unhandled exception in disposer:', error)
        }
      }

      disposers.add(safeDisposer)

      return () => {
        disposers.delete(safeDisposer)
      }
    },

    timeout(fn, ms) {
      if (isDisposed)
        return noop

      const timer = setTimeout(() => {
        activeTimeouts.delete(timer)
        fn()
      }, ms)

      activeTimeouts.add(timer)

      const cancel = () => activeTimeouts.delete(timer) && clearTimeout(timer)

      const unhook = controller.add(cancel)
      return () => {
        cancel()
        unhook()
      }
    },

    interval(fn, ms) {
      if (isDisposed)
        return noop

      const timer = setInterval(fn, ms)
      const cancel = () => clearInterval(timer)

      const unhook = controller.add(cancel)
      return () => {
        cancel()
        unhook()
      }
    },

    listen(type, fn, options) {
      if (isDisposed)
        return noop

      const handler = fn as EventListener
      document.addEventListener(type, handler, options)

      const remove = () => document.removeEventListener(type, handler, options)
      const unhook = controller.add(remove)

      return () => {
        remove()
        unhook()
      }
    },

    listenEvent(event, fn) {
      if (isDisposed)
        return noop

      let unlisten: (() => void) | undefined
      let removed = false
      const remove = () => {
        removed = true
        unlisten?.()
        unlisten = undefined
      }
      void listen(event, (payload) => {
        if (!removed)
          (fn as (event: unknown) => void)(payload)
      }).then((off) => {
        if (removed)
          off()
        else
          unlisten = off
      })
      const unhook = controller.add(remove)
      return () => {
        remove()
        unhook()
      }
    },

    listenWindow(type, fn, options) {
      if (isDisposed || typeof window === 'undefined')
        return noop

      const handler = fn as EventListener
      window.addEventListener(type, handler, options)

      const remove = () => window.removeEventListener(type, handler, options)
      const unhook = controller.add(remove)
      return () => {
        remove()
        unhook()
      }
    },

    observe(target, onMutate, options) {
      const observer = new MutationObserver(onMutate)

      if (!isDisposed) {
        observer.observe(target, options ?? DEFAULT_MUTATION_OPTIONS)
        controller.add(() => observer.disconnect())
      }

      return observer
    },

    isDisposed: () => isDisposed,

    dispose() {
      if (isDisposed)
        return

      isDisposed = true

      for (const timer of activeTimeouts)
        clearTimeout(timer)
      activeTimeouts.clear()

      for (const disposer of [...disposers])
        disposer()
      disposers.clear()
    },
  }

  return controller
}
