import type { ClientContext } from 'dsh-tauri/client'
import type { AccessStatus, MachineRow } from '../types/index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as accessService from '../service/access'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { pollFeature } from './poll'

const baseURL = '/api/tauri/remote'

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
  store.access.reset()
  answer(call => call.url === `${baseURL}/machines`
    ? replies.ok({ items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] })
    : replies.ok({ items: [] }))
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('polls access during the first long tunnel mutation even when the saved snapshot is still stopped', async () => {
    vi.useFakeTimers()
    const mutation = Promise.withResolvers<ReturnType<typeof replies.ok>>()
    const downloading = { enabled: true, tunnel: { enabled: true, mode: 'quick', state: 'starting', progress: { stage: 'download', received: 1, total: 2 } } }
    answer(call => call.http === 'POST' ? mutation.promise : replies.ok(downloading))
    store.access.snapshot = {
      version: 1,
      enabled: false,
      state: 'stopped',
      listening: false,
      listen: { address: '127.0.0.1', port: 3088 },
      port: 3088,
      auth: { enabled: true, scope: 'all' },
      addresses: [],
      events: [],
      tunnel: { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] },
    }
    const stop = pollFeature.call({} as unknown as ClientContext)
    const pending = accessService.startTunnel({ mode: 'quick' })
    try {
      await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS)
      expect(sent.map(call => [call.http, call.url])).toEqual([
        ['POST', `${baseURL}/access/tunnel`],
        ['GET', `${baseURL}/access`],
      ])
      expect(store.access.busy).toBe(true)
      expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })
      mutation.resolve(replies.ok(downloading))
      await pending
    }
    finally {
      stop()
      mutation.resolve(replies.ok(downloading))
      await pending
    }
  })

  it('polls starting tunnels while busy and stops access polling when ready', async () => {
    vi.useFakeTimers()
    const snapshot: AccessStatus = {
      version: 1,
      enabled: false,
      state: 'stopped',
      listening: false,
      listen: { address: '127.0.0.1', port: 3088 },
      port: 3088,
      auth: { enabled: true, scope: 'all' },
      addresses: [],
      events: [],
      tunnel: { enabled: true, mode: 'quick', hostname: null, state: 'starting', events: [], progress: { stage: 'download', received: 1, total: 2 } },
    }
    store.access.commit(snapshot)
    store.access.beginBusy()
    answer(() => replies.ok(snapshot))
    const stop = pollFeature.call({} as unknown as ClientContext)
    try {
      await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS)
      expect(urls()).toEqual([`${baseURL}/access`])
      expect(store.access.busy).toBe(true)
      store.access.endBusy()
      store.access.commit({ ...snapshot, tunnel: { ...snapshot.tunnel, state: 'running' } })
      await vi.advanceTimersByTimeAsync(MACHINES_INTERVAL_MS * 2)
      expect(urls()).toEqual([`${baseURL}/access`])
    }
    finally {
      stop()
    }
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
