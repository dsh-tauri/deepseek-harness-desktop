import { createLinkToken, tokenMatches } from '../utils/auth'

export const PAIRING_TTL_MS = 5 * 60 * 1000

const PAIRING_WAIT_MS = 8000

const waiters = new Set<() => void>()

let current: { code: string, expiresAt: number, usedSeq: number } | undefined

export function pairingCodeOf(now = Date.now()): { code: string, expiresAt: number, usedSeq: number } {
  if (current === undefined || current.expiresAt <= now) {
    let code: string
    do {
      code = createLinkToken()
    } while (code === current?.code)
    current = { code, expiresAt: now + PAIRING_TTL_MS, usedSeq: current?.usedSeq ?? 0 }
  }
  return current
}

export function consumePairingCode(provided: string): boolean {
  const now = Date.now()
  const pairing = pairingCodeOf(now)
  if (!tokenMatches(provided, pairing.code))
    return false
  current = { ...pairing, expiresAt: now, usedSeq: pairing.usedSeq + 1 }
  pairingCodeOf(now)
  for (const finish of waiters)
    finish()
  return true
}

export function waitForPairingUse(since: number, signal?: AbortSignal): Promise<void> {
  if (pairingCodeOf().usedSeq !== since || signal?.aborted === true)
    return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (): void => {
      clearTimeout(timer)
      waiters.delete(finish)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, PAIRING_WAIT_MS)
    waiters.add(finish)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export function resetPairingCode(): void {
  current = undefined
  for (const finish of waiters)
    finish()
}
