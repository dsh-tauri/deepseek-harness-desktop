import type { MachineListSnapshot } from '../../types/index'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../index'

vi.mock('dsh-tauri/client', async () => (await import('../../test-utils/client-mock')).clientMock)

const machineA = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}
const machineB = { ...machineA, id: 'b', name: 'beta' }

function snapshot(rows: MachineListSnapshot['machines'], statuses: MachineListSnapshot['statuses'] = {}): MachineListSnapshot {
  return {
    machines: rows,
    discovered: [],
    statuses: Object.fromEntries(rows.map(row => [row.id, statuses[row.id] ?? { state: 'disconnected' as const }])),
  }
}

beforeEach(() => {
  store.machines.reset()
})

describe('commitList', () => {
  it('publishes the rows, the statuses, and the phase trail', () => {
    store.machines.commitList(snapshot([machineA, machineB], {
      a: { state: 'connecting', progress: { phase: 'handshake' } },
    }))
    expect(store.machines.machines.map(row => row.id)).toEqual(['a', 'b'])
    expect(store.machines.statuses.a).toEqual({ state: 'connecting', progress: { phase: 'handshake' } })
    expect(store.machines.trails.a).toEqual(['handshake'])
    expect(store.machines.status).toBe('ready')
  })

  it('drops the trail and the cursor of a machine that vanished', () => {
    store.machines.commitList(snapshot([machineA, machineB], {
      a: { state: 'connecting', progress: { phase: 'probing' } },
      b: { state: 'connecting', progress: { phase: 'probing' } },
    }))
    store.machines.advanceEvents({ a: 4, b: 9 })
    store.machines.commitList(snapshot([machineA]))
    expect(store.machines.trails.b).toBeUndefined()
    expect(store.machines.eventCursors).toEqual({ a: 4 })
  })

  it('keeps the same trail array while the phase does not move', () => {
    store.machines.commitList(snapshot([machineA], { a: { state: 'connecting', progress: { phase: 'probing' } } }))
    const first = store.machines.trails.a
    store.machines.commitList(snapshot([machineA], { a: { state: 'connecting', progress: { phase: 'probing' } } }))
    expect(store.machines.trails.a).toBe(first)
  })
})

describe('appendLogs', () => {
  it('appends to the previous lines and caps the tail', () => {
    store.machines.appendLogs({ a: ['line 1'] })
    store.machines.appendLogs({ a: ['line 2'] })
    expect(store.machines.logs.a).toEqual(['line 1', 'line 2'])

    store.machines.appendLogs({ a: Array.from({ length: 310 }, (_, index) => `line ${index + 3}`) })
    expect(store.machines.logs.a).toHaveLength(300)
    expect(store.machines.logs.a?.at(-1)).toBe('line 312')
    expect(store.machines.logs.a?.[0]).toBe('line 13')
  })
})

describe('probe outcomes', () => {
  it('only fills in a status when the machine had none', () => {
    store.machines.commitProbeOk('a', 'Linux alpha')
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected' })
    expect(store.machines.notice).toEqual({ kind: 'text', text: 'Linux alpha' })

    store.machines.commitConnected('a', 'http://127.0.0.1:1')
    store.machines.commitProbeOk('a')
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.probe_ok' })
  })

  it('defaults the failure reason and keeps a live connection', () => {
    store.machines.commitProbeFailed('a')
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected', lastError: 'failed' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.probe_failed' })

    store.machines.commitConnected('b', 'http://127.0.0.1:2')
    store.machines.commitProbeFailed('b', 'auth failed')
    expect(store.machines.statuses.b).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:2', lastError: 'auth failed' })
    expect(store.machines.notice).toEqual({ kind: 'text', text: 'auth failed' })
  })
})

describe('the busy slot', () => {
  it('tracks one in-flight operation per machine', () => {
    store.machines.beginOp('a', 'connect')
    expect(store.machines.busy).toEqual({ a: 'connect' })
    store.machines.endOp('a')
    expect(store.machines.busy).toEqual({})
  })

  it('clears the banner when an operation starts', () => {
    store.machines.fail('nope')
    store.machines.beginOp('a', 'test')
    expect(store.machines.error).toBeNull()
  })
})

describe('the feature switch', () => {
  it('tracks the enable round trip', () => {
    store.machines.setEnabled(false, null)
    store.machines.beginEnable()
    expect(store.machines.enabling).toBe(true)
    store.machines.setEnabled(true, null)
    store.machines.endEnable()
    expect(store.machines.enabled).toBe(true)
    expect(store.machines.enabling).toBe(false)
    expect(store.machines.error).toBeNull()
  })
})

describe('the migration warning', () => {
  it('carries the host warning until a later read reports none', () => {
    store.machines.setMigrationWarning('ssh/machines.json 不是合法 JSON')
    expect(store.machines.migrationWarning).toBe('ssh/machines.json 不是合法 JSON')
    store.machines.setMigrationWarning(null)
    expect(store.machines.migrationWarning).toBeNull()
  })
})

describe('event cursors', () => {
  it('only ever moves a cursor forward', () => {
    store.machines.advanceEvents({ a: 5 })
    store.machines.advanceEvents({ a: 3 })
    expect(store.machines.eventCursors.a).toBe(5)
    store.machines.advanceEvents({ a: 7 })
    expect(store.machines.eventCursors.a).toBe(7)
  })

  it('turns the channel off for the session', () => {
    store.machines.disableEvents()
    expect(store.machines.eventsSupported).toBe(false)
  })
})

describe('reset', () => {
  it('restores the initial state', () => {
    store.machines.commitList(snapshot([machineA]))
    store.machines.disableEvents()
    store.machines.fail('nope')
    store.machines.reset()
    expect(store.machines.$state).toEqual({
      status: 'idle',
      error: null,
      enabled: null,
      enabling: false,
      machines: [],
      discovered: [],
      statuses: {},
      logs: {},
      trails: {},
      busy: {},
      notice: null,
      installResults: {},
      role: null,
      migrationWarning: null,
      eventCursors: {},
      eventsSupported: true,
    })
  })
})
