import { describe, expect, it } from 'vitest'
import { BoundedReloadGate, pollReadiness, SingleFlight, waitForActivityTask } from '../../src/store/modules/harness/readiness'

function noWait(): Promise<void> {
  return Promise.resolve()
}

describe('pollReadiness', () => {
  it('stops after the initial bounded attempts', async () => {
    let attempts = 0
    const result = await pollReadiness({
      probe: async () => {
        attempts++
        return { healthy: false, notOwned: false }
      },
      intervalMs: 0,
      maxAttempts: 3,
      wait: noWait,
    })

    expect(result).toEqual({ healthy: false, notOwned: false })
    expect(attempts).toBe(3)
  })

  it('recovers when client modules become ready after the old attempt window', async () => {
    let attempts = 0
    const result = await pollReadiness({
      probe: async () => {
        attempts++
        return {
          healthy: attempts === 12,
          notOwned: false,
          phase: 'client-modules',
          reason: attempts < 6 ? '0/2 modules ready' : '1/2 modules ready',
        }
      },
      intervalMs: 0,
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      wait: noWait,
    })

    expect(result.healthy).toBe(true)
    expect(attempts).toBe(12)
  })

  it('returns an absolute timeout even while readiness reasons keep changing', async () => {
    let clock = 0
    const result = await pollReadiness({
      probe: async () => ({
        healthy: false,
        notOwned: false,
        phase: 'client-modules',
        reason: `heartbeat ${clock}`,
      }),
      intervalMs: 10,
      inactivityTimeoutMs: 25,
      absoluteTimeoutMs: 50,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
      },
    })

    expect(result.timeout).toBe('absolute')
    expect(clock).toBe(50)
  })

  it('returns an inactivity timeout when no progress is observed', async () => {
    let clock = 0
    const result = await pollReadiness({
      probe: async () => ({
        healthy: false,
        notOwned: false,
        phase: 'process-boot',
        reason: 'service is still starting',
      }),
      intervalMs: 10,
      inactivityTimeoutMs: 30,
      absoluteTimeoutMs: 100,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
      },
    })

    expect(result.timeout).toBe('inactivity')
    expect(clock).toBe(30)
  })

  it('fails immediately when the owned process exits', async () => {
    let attempts = 0
    const result = await pollReadiness({
      probe: async () => {
        attempts++
        return {
          healthy: false,
          notOwned: true,
          phase: 'process-boot',
          reason: 'owned process exited',
        }
      },
      intervalMs: 10,
      inactivityTimeoutMs: 30,
      absoluteTimeoutMs: 100,
      wait: noWait,
    })

    expect(result.notOwned).toBe(true)
    expect(result.reason).toBe('owned process exited')
    expect(attempts).toBe(1)
  })

  it('discards a healthy probe result when recovery is cancelled while probing', async () => {
    let active = true
    const pendingProbe = Promise.withResolvers<{ healthy: boolean, notOwned: boolean }>()
    const resultPromise = pollReadiness({
      probe: () => pendingProbe.promise,
      intervalMs: 0,
      shouldContinue: () => active,
      wait: noWait,
    })

    active = false
    pendingProbe.resolve({ healthy: true, notOwned: false })

    await expect(resultPromise).resolves.toEqual({ healthy: false, notOwned: false })
  })
})

describe('waitForActivityTask', () => {
  it('allows plugin installation to exceed the old deadline while heartbeats continue', async () => {
    let clock = 0
    let sequence = 0
    const task = Promise.withResolvers<string>()
    const result = await waitForActivityTask({
      task: task.promise,
      getActivity: () => ({ sequence, reason: `plugin heartbeat ${sequence}` }),
      inactivityTimeoutMs: 30,
      absoluteTimeoutMs: 120,
      intervalMs: 10,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
        sequence++
        if (clock === 70) {
          task.resolve('installed')
        }
      },
    })

    expect(result.completed).toBe(true)
    expect(result.value).toBe('installed')
    expect(clock).toBe(70)
  })

  it('caps a progressing plugin installation at its absolute deadline', async () => {
    let clock = 0
    let sequence = 0
    const result = await waitForActivityTask({
      task: new Promise<never>(() => {}),
      getActivity: () => ({ sequence, reason: `plugin heartbeat ${sequence}` }),
      inactivityTimeoutMs: 30,
      absoluteTimeoutMs: 50,
      intervalMs: 10,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
        sequence++
      },
    })

    expect(result.timeout).toBe('absolute')
    expect(clock).toBe(50)
  })

  it('uses the absolute deadline when a no-progress phase has a longer inactivity allowance', async () => {
    let clock = 0
    const result = await waitForActivityTask({
      task: new Promise<never>(() => {}),
      getActivity: () => ({ sequence: 0, reason: 'waiting for plugin process' }),
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 40,
      intervalMs: 10,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
      },
    })

    expect(result.timeout).toBe('absolute')
    expect(result.reason).toBe('waiting for plugin process')
  })
})

describe('single flight', () => {
  it('coalesces concurrent restarts and permits a later restart', async () => {
    const flight = new SingleFlight<void>()
    const first = Promise.withResolvers<void>()
    let runs = 0
    function restart(): Promise<void> {
      return flight.run(async () => {
        runs++
        await first.promise
      })
    }

    const one = restart()
    const duplicate = restart()
    expect(one).toBe(duplicate)
    expect(runs).toBe(1)

    first.resolve()
    await one
    await restart()
    expect(runs).toBe(2)
  })
})

describe('bounded reload gate', () => {
  it('ignores duplicate stalled and ready events without creating reload loops', () => {
    const gate = new BoundedReloadGate(2)

    expect(gate.request(0)).toBe('reload')
    expect(gate.request(0)).toBe('duplicate')
    expect(gate.request(1)).toBe('reload')
    expect(gate.request(2)).toBe('exhausted')

    gate.markReady()
    expect(gate.request(3)).toBe('ready')
    expect(gate.request(3)).toBe('ready')

    gate.reset()
    expect(gate.request(0)).toBe('reload')
  })
})
