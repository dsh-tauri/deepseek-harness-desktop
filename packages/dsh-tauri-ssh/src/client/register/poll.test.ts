import type { ClientContext } from 'dsh-tauri/client'
import type { MachineRow } from '../types/index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { pollFeature } from './poll'

const baseURL = '/api/tauri/ssh'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const MACHINES_INTERVAL_MS = 1500

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}

const urls = (): string[] => sent.map(call => call.url)

beforeEach(() => {
  resetWire()
  store.machines.reset()
  store.sync.reset()
  answer(call => call.url === `${baseURL}/machines`
    ? replies.ok({ items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] })
    : replies.ok({ items: [] }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pollFeature', () => {
  it('polls the host while an operation is in flight and stops when idle', async () => {
    vi.useFakeTimers()
    const stop = pollFeature.call({} as unknown as ClientContext)
    store.machines.status = 'ready'
    store.machines.machines = [machineA]
    store.machines.statuses = { a: { state: 'connecting', progress: { phase: 'handshake' } } }

    const before = sent.length
    await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS + 100)
    expect(sent.length).toBe(before + 2)
    expect(urls()).toEqual([`${baseURL}/machines`, `${baseURL}/machines/events`])

    store.machines.statuses = { a: { state: 'disconnected' } }
    store.machines.busy = {}
    const idle = sent.length
    await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS * 2)
    expect(sent.length).toBe(idle)

    stop()
  })

  it('refreshes while an apply is running and stops when it finishes', async () => {
    vi.useFakeTimers()
    const stop = pollFeature.call({} as unknown as ClientContext)
    store.sync.applying = true

    await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS + 50)
    expect(sent.length).toBe(2)

    store.sync.applying = false
    store.machines.statuses = {}
    const idle = sent.length
    await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS * 2)
    expect(sent.length).toBe(idle)

    stop()
  })

  it('disposes the interval when the feature unloads', async () => {
    vi.useFakeTimers()
    const stop = pollFeature.call({} as unknown as ClientContext)
    store.machines.statuses = { a: { state: 'connecting' } }
    stop()

    await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS * 2)
    expect(sent).toHaveLength(0)
  })
})
