import type { EventCallback, EventName, Options, UnlistenFn } from '../service/tauri'
import { useEffect, useRef } from 'react'
import { listen } from '../service/tauri'

export function useListen<T>(event: EventName, handler: EventCallback<T>, options?: Options): void {
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)
  handlerRef.current = handler
  optionsRef.current = options

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false

    void listen<T>(event, tauriEvent => handlerRef.current(tauriEvent), optionsRef.current)
      .then((fn) => {
        if (disposed)
          fn()
        else
          unlisten = fn
      })
      .catch(err => console.error(`[useListen] failed to listen ${event}:`, err))

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [event])
}
