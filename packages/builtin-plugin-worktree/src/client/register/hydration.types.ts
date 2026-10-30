export interface KeyedThrottleOptions {
  intervalMs: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface KeyedThrottle {
  request: (key: string, run: () => void) => void
  cancel: (key: string) => void
  clear: () => void
}
