/**
 * Pure time helpers for the machine-status line. The host reports the next
 * reconnect retry as an epoch-ms instant (`nextRetryAt`, S3-owned); the UI
 * renders it as a short relative hint, so the clock math lives here as a
 * pure function (testable without React or a store).
 * @module dsh-tauri-ssh-ui/client/utils/retry
 */

/**
 * Whole seconds until the scheduled retry, rounded up so a partial second
 * still reads as a full one (a "0s" hint would look like a bug while the
 * retry has not fired yet).
 * @param nextRetryAt - the epoch-ms instant the retry fires.
 * @param nowMs - the reference clock (injected; tests pin it).
 * @returns the remaining seconds; `0` means the retry is due now or overdue.
 */
export function retrySecondsOf(nextRetryAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((nextRetryAt - nowMs) / 1000))
}
