import type { MutableRefObject } from 'react'
import { useEffect, useRef } from 'react'

export interface TimersController {
  mounted: MutableRefObject<boolean>
  later: (callback: () => void, delay: number) => void
}

export function useTimers(): TimersController {
  const timersRef = useRef<Set<number>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => {
    const timers = timersRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const timer of timers)
        window.clearTimeout(timer)
      timers.clear()
    }
  }, [])
  return {
    mounted: mountedRef,
    later(callback, delay) {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer)
        if (mountedRef.current)
          callback()
      }, delay)
      timersRef.current.add(timer)
    },
  }
}
