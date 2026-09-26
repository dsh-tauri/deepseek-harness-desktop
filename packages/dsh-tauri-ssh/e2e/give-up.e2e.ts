/**
 * E2E #2 — backoff rhythm and the give-up terminal state, driven by a
 * persistently unreachable local port (nothing listens on 127.0.0.1:1).
 * Records every event timestamp so the exponential schedule is readable in
 * the evidence log.
 * @module dsh-tauri-ssh/e2e/give-up
 */

import type { MachineProfile } from '../src/host/types/index'
import { describe, expect, it } from 'vitest'
import { bootHarness, id, waitFor } from './helpers'

const profile: MachineProfile = {
  id: id('unreachable'),
  name: 'unreachable',
  host: '127.0.0.1',
  port: 1,
  user: 'root',
  remotePort: 3080,
}

describe('e2e give-up (local unreachable port)', () => {
  it('retries on an exponential schedule, then lands in given-up', async () => {
    const harness = bootHarness({
      connectTimeoutMs: 2_000,
      reconnectInitialDelayMs: 300,
      reconnectMaxDelayMs: 1_200,
      reconnectMaxAttempts: 4,
    })
    const { manager } = harness
    try {
      manager.refreshProfiles(new Map([[profile.id, profile]]))

      // The first failure rejects the caller's connect; the loop continues.
      await expect(manager.connect(profile.id)).rejects.toThrow()
      await waitFor(() => manager.status(profile.id).state === 'given-up', 'give-up', 30_000)

      const status = manager.status(profile.id)
      expect(status.state).toBe('given-up')
      expect(status.nextRetryAt).toBeUndefined()
      expect(status.lastError).toMatch(/connect failed after 5 attempt\(s\)/u)
      expect(status.lastError).toMatch(/host unreachable/u)

      // The retry schedule from the event log: one auth failure per attempt,
      // one reconnect line per scheduled retry, gaps growing 300→600→1200→1200.
      const retryLines = harness.evidence.filter(line => line.text.includes('event reconnect: retrying'))
      const gaps: number[] = []
      let previous: number | undefined
      for (const line of retryLines) {
        if (previous !== undefined)
          gaps.push(line.at - previous)
        previous = line.at
      }
      harness.log(`retry gaps: ${gaps.join(', ')} ms`)
      expect(gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of gaps)
        expect(gap).toBeGreaterThan(0)
      // Each gap at least as long as the previous one (the schedule only
      // grows, capped at 1.2 s; small scheduling jitter tolerated).
      for (let i = 1; i < gaps.length; i++)
        expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 50)

      // A manual disconnect after give-up is a different, clean terminal.
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')
    }
    finally {
      await harness.dispose()
    }
  }, 120_000)
})
