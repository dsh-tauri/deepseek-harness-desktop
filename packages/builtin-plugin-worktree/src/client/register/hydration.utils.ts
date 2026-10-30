import type { KeyedThrottle, KeyedThrottleOptions } from './hydration.types'

interface KeyEntry {
  lastRunAt: number
  cancelTimer: () => void
  pending: (() => void) | null
}

export function createKeyedThrottle(options: KeyedThrottleOptions): KeyedThrottle {
  const intervalMs = Math.max(0, options.intervalMs)
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  })
  const entries = new Map<string, KeyEntry>()

  return {
    request(key, run) {
      const entry = entries.get(key)
      if (!entry) {
        entries.set(key, { lastRunAt: now(), cancelTimer: () => {}, pending: null })
        run()
        return
      }
      if (entry.pending) {
        entry.pending = run
        return
      }
      const delay = intervalMs - (now() - entry.lastRunAt)
      if (delay <= 0) {
        entry.lastRunAt = now()
        run()
        return
      }
      entry.pending = run
      entry.cancelTimer = schedule(() => {
        const pending = entry.pending
        entry.pending = null
        entry.cancelTimer = () => {}
        if (!pending)
          return
        entry.lastRunAt = now()
        pending()
      }, delay)
    },
    cancel(key) {
      const entry = entries.get(key)
      if (!entry)
        return
      entry.cancelTimer()
      entries.delete(key)
    },
    clear() {
      entries.forEach(entry => entry.cancelTimer())
      entries.clear()
    },
  }
}
