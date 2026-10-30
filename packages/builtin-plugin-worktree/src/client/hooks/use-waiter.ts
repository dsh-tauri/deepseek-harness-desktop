import type { Waiter } from './use-waiter.types'
import { useEffect, useRef } from 'react'

export function useWaiter(): Waiter {
  const timersRef = useRef<Set<number>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
    for (const timer of timersRef.current)
      window.clearTimeout(timer)
    timersRef.current.clear()
  }, [])
  return {
    mountedRef,
    wait: ms => new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer)
        resolve()
      }, ms)
      timersRef.current.add(timer)
    }),
  }
}
