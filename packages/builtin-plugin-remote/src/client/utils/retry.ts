export function retrySecondsOf(nextRetryAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((nextRetryAt - nowMs) / 1000))
}
