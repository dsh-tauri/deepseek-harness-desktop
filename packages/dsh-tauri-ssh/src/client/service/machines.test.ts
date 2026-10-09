import type { MachineRow } from '../types/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../apis/index'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import * as service from './machines'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const API = '/api/tauri/ssh'

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
const machineB: MachineRow = {
  ...machineA,
  id: 'b',
  name: 'beta',
  host: '10.0.0.2',
  port: 2222,
  user: 'deploy',
  hasPassword: false,
  hasPassphrase: true,
  remotePort: 3000,
  startCommand: 'dsh web --host 127.0.0.1 --port 3000',
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const callsOf = (path: string, http: string) => sent.filter(call => call.url === `${API}${path}` && call.http === http)
const bodiesOf = (path: string, http: string) => callsOf(path, http).map(call => call.body)
const paramsOf = (path: string, http = 'GET') => callsOf(path, http).map(call => call.params)

function wireList(items: readonly unknown[], discovered: readonly unknown[] = []): void {
  answer((call) => {
    if (call.url === `${API}/machines`)
      return replies.ok({ items, discovered })
    return replies.ok(call.url === `${API}/session/role` ? { remote: false } : {})
  })
}

beforeEach(() => {
  resetWire()
  store.machines.reset()
  store.sync.reset()
})

describe('load', () => {
  it('loads the machines, their secret flags, and their live statuses', async () => {
    wireList([
      { ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' },
      { ...machineB, state: 'disconnected', lastError: 'auth failed' },
    ])
    await service.load()
    expect(store.machines.machines).toEqual([machineA, machineB])
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    expect(store.machines.statuses.b).toEqual({ state: 'disconnected', lastError: 'auth failed' })
    expect(store.machines.status).toBe('ready')
    expect(store.machines.error).toBeNull()
    await vi.waitFor(() => expect(store.machines.role).toEqual({ remote: false }))
  })

  it('carries the retry instant, the auth method, and the dsh marker', async () => {
    wireList([
      { ...machineA, state: 'reconnecting', nextRetryAt: 1_700_000_008_000, authMethod: 'key' },
      { ...machineB, state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true },
    ])
    await service.load()
    expect(store.machines.statuses.a).toMatchObject({ state: 'reconnecting', nextRetryAt: 1_700_000_008_000, authMethod: 'key' })
    expect(store.machines.statuses.b).toMatchObject({ state: 'disconnected', dshMissing: true })
  })

  it('appends the phase trail and clears it when progress disappears', async () => {
    wireList([{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }])
    await service.load()
    expect(store.machines.trails.a).toEqual(['handshake'])

    wireList([{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }])
    await service.poll()
    expect(store.machines.trails.a).toEqual(['handshake', 'starting'])

    wireList([{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }])
    await service.poll()
    expect(store.machines.trails.a).toEqual(['handshake', 'starting'])

    wireList([{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }])
    await service.poll()
    expect(store.machines.trails.a).toBeUndefined()
  })

  it('polls without flipping the loading banner', async () => {
    wireList([machineA])
    await service.load()
    let release: ((reply: ReturnType<typeof replies.ok>) => void) | undefined
    answer((call) => {
      if (call.url === `${API}/machines`)
        return new Promise((resolve) => { release = resolve })
      return replies.ok({})
    })
    const pending = service.poll()
    await tick()
    expect(store.machines.status).toBe('ready')
    release?.(replies.ok({ items: [machineA], discovered: [] }))
    await pending
    expect(store.machines.status).toBe('ready')
  })

  it('tolerates a list response without the items key', async () => {
    answer(() => replies.ok({}))
    await service.load()
    expect(store.machines.status).toBe('ready')
    expect(store.machines.machines).toEqual([])
  })

  it('loads the discovered aliases alongside the manual machines', async () => {
    wireList([machineA], [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root' }])
    await service.load()
    expect(store.machines.machines.map(row => row.id)).toEqual(['a'])
    expect(store.machines.discovered.map(row => row.id)).toEqual(['dev'])
  })

  it('reports a list failure on the status line', async () => {
    answer(() => replies.fail('loopback only'))
    await service.load()
    expect(store.machines.status).toBe('error')
    expect(store.machines.error).toBe('loopback only')
  })

  it('reports a poll failure without dropping the list', async () => {
    wireList([machineA])
    await service.load()
    answer(() => replies.fail('nope'))
    await service.poll()
    expect(store.machines.status).toBe('ready')
    expect(store.machines.error).toBe('nope')
    expect(store.machines.machines.map(row => row.id)).toEqual(['a'])
  })
})

describe('persist', () => {
  it('saves the edited rows, the typed secrets, and removes the vanished machines', async () => {
    let items: readonly unknown[] = [machineA, machineB]
    answer(call => call.url === `${API}/machines` ? replies.ok({ items, discovered: [] }) : replies.ok({ remote: false }))
    await service.load()
    const renamed = { ...machineA, name: 'alpha-2' }
    items = [renamed]
    sent.length = 0
    const result = await service.persist({ machines: [renamed], secrets: { a: { password: 'sekrit', passphrase: 'PHRASE' } } })
    expect(result).toEqual({ ok: true })
    expect(bodiesOf('/machines', 'POST')).toEqual([{
      machineId: 'a',
      row: { name: 'alpha-2', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
      secrets: { password: 'sekrit', passphrase: 'PHRASE' },
    }])
    expect(bodiesOf('/machines', 'DELETE')).toEqual([{ machineId: 'b' }])
    expect(store.machines.error).toBeNull()
    expect(store.machines.machines.map(row => row.id)).toEqual(['a'])
  })

  it('never persists a discovered alias', async () => {
    wireList([machineA], [{ ...machineA, id: 'dev', name: 'dev', host: 'dev' }])
    await service.load()
    sent.length = 0
    await service.persist({ machines: [machineA], secrets: {} })
    expect(bodiesOf('/machines', 'POST')).toEqual([{ machineId: 'a', row: { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 } }])
    expect(bodiesOf('/machines', 'DELETE')).toEqual([])
  })

  it('reports a save failure without throwing', async () => {
    wireList([machineA])
    await service.load()
    answer(call => call.url === `${API}/machines` && call.http === 'POST' ? replies.fail('nope') : replies.ok({ items: [machineA], discovered: [] }))
    await expect(service.persist({ machines: [machineA], secrets: {} })).resolves.toEqual({ ok: false, error: 'nope' })
    expect(store.machines.error).toBe('nope')
  })
})

describe('machine actions', () => {
  beforeEach(async () => {
    wireList([machineA])
    await service.load()
    sent.length = 0
  })

  it('publishes the probe banner and tracks the busy slot', async () => {
    answer(() => replies.ok({ ok: true, banner: 'Linux alpha' }))
    await expect(service.test({ machineId: 'a' })).resolves.toEqual({ ok: true })
    expect(store.machines.notice).toEqual({ kind: 'text', text: 'Linux alpha' })
    expect(store.machines.busy).toEqual({})
    expect(bodiesOf('/machines/test', 'POST')).toEqual([{ machineId: 'a' }])
  })

  it('falls back to the locale keys when the probe says nothing', async () => {
    answer(() => replies.ok({ ok: true }))
    await service.test({ machineId: 'a' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.probe_ok' })
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected' })

    answer(() => replies.ok({ ok: false }))
    await service.test({ machineId: 'a' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.probe_failed' })
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected', lastError: 'failed' })
  })

  it('reports a failed probe message', async () => {
    answer(() => replies.ok({ ok: false, message: 'auth failed' }))
    await service.test({ machineId: 'a' })
    expect(store.machines.notice).toEqual({ kind: 'text', text: 'auth failed' })
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected', lastError: 'auth failed' })
  })

  it('never downgrades a live connection after a probe', async () => {
    answer(call => call.url === `${API}/machines/connect`
      ? replies.ok({ tunnelBaseUrl: 'http://127.0.0.1:49152' })
      : replies.ok({ ok: true }))
    await service.connect({ machineId: 'a' })
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })

    await service.test({ machineId: 'a' })
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })

    answer(() => replies.ok({ ok: false, message: 'auth failed' }))
    await service.test({ machineId: 'a' })
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152', lastError: 'auth failed' })
  })

  it('connects and disconnects with the tunnel URL in the notice', async () => {
    answer(call => call.url === `${API}/machines/connect`
      ? replies.ok({ tunnelBaseUrl: 'http://127.0.0.1:49152' })
      : replies.ok({}))
    await service.connect({ machineId: 'a' })
    expect(store.machines.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.connected', params: { url: 'http://127.0.0.1:49152' } })

    await service.disconnect({ machineId: 'a' })
    expect(store.machines.statuses.a).toEqual({ state: 'disconnected' })
    expect(store.machines.notice).toEqual({ kind: 'key', key: 'notice.disconnected' })
    expect(bodiesOf('/machines/connect', 'POST')).toEqual([{ machineId: 'a' }])
    expect(bodiesOf('/machines/disconnect', 'POST')).toEqual([{ machineId: 'a' }])
  })

  it('exposes the in-flight operation in the busy map', async () => {
    let release: ((reply: ReturnType<typeof replies.ok>) => void) | undefined
    answer(call => call.url === `${API}/machines/connect`
      ? new Promise((resolve) => { release = resolve })
      : replies.ok({}))
    const pending = service.connect({ machineId: 'a' })
    await tick()
    expect(store.machines.busy.a).toBe('connect')
    release?.(replies.ok({ tunnelBaseUrl: 'http://127.0.0.1:49152' }))
    await pending
    expect(store.machines.busy).toEqual({})
  })

  it('lands connection-plane failures on the error banner', async () => {
    answer(() => replies.fail('refused'))
    await expect(service.connect({ machineId: 'a' })).resolves.toEqual({ ok: false, error: 'refused' })
    expect(store.machines.error).toBe('refused')

    answer(() => replies.empty())
    await service.connect({ machineId: 'a' })
    expect(store.machines.error).toBe('SSH_API_EMPTY')

    answer(() => replies.http(405))
    await service.connect({ machineId: 'a' })
    expect(store.machines.error).toBe('SSH_API_HTTP_405')
  })

  it('records an install result and reloads the list', async () => {
    answer(call => call.url === `${API}/machines/install`
      ? replies.ok({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true })
      : replies.ok({ items: [machineA], discovered: [] }))
    await service.install({ machineId: 'a' })
    expect(store.machines.installResults.a).toEqual({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true })
    expect(callsOf('/machines', 'GET').length).toBeGreaterThanOrEqual(1)
    expect(store.machines.busy).toEqual({})
  })

  it('lands an install failure on the error banner', async () => {
    answer(call => call.url === `${API}/machines/install` ? replies.fail('pnpm: not found') : replies.ok({ items: [machineA], discovered: [] }))
    await expect(service.install({ machineId: 'a' })).resolves.toEqual({ ok: false, error: 'pnpm: not found' })
    expect(store.machines.error).toBe('pnpm: not found')
    expect(store.machines.busy).toEqual({})
  })
})

describe('feature switch', () => {
  it('reads the switch and skips loading while disabled', async () => {
    answer(call => call.url === `${API}/settings` && call.http === 'GET' ? replies.ok({ enabled: false }) : replies.ok({}))
    await service.loadSettings()
    expect(store.machines.enabled).toBe(false)
    expect(store.machines.error).toBeNull()

    sent.length = 0
    await service.load()
    expect(store.machines.status).toBe('idle')
    expect(callsOf('/machines', 'GET')).toEqual([])
  })

  it('enables through settings.set and then loads the machines', async () => {
    answer((call) => {
      if (call.url === `${API}/settings`)
        return replies.ok({ enabled: call.http === 'POST' })
      if (call.url === `${API}/machines`)
        return replies.ok({ items: [machineA], discovered: [] })
      return replies.ok({ remote: false })
    })
    await service.loadSettings()
    await expect(service.setEnabled(true)).resolves.toEqual({ ok: true })
    expect(store.machines.enabled).toBe(true)
    expect(store.machines.enabling).toBe(false)
    expect(store.machines.machines.map(row => row.id)).toEqual(['a'])
  })

  it('keeps SSH enabled when disabling fails and clears the pending flag', async () => {
    store.machines.setEnabled(true, null)
    answer(() => replies.fail('cannot save'))
    await expect(service.setEnabled(false)).resolves.toEqual({ ok: false, error: 'cannot save' })
    expect(store.machines.enabled).toBe(true)
    expect(store.machines.enabling).toBe(false)
    expect(store.machines.error).toBe('cannot save')
  })

  it('disables without reloading machines', async () => {
    store.machines.setEnabled(true, null)
    answer(() => replies.ok({ enabled: false }))
    await expect(service.setEnabled(false)).resolves.toEqual({ ok: true })
    expect(store.machines.enabled).toBe(false)
    expect(store.machines.enabling).toBe(false)
    expect(callsOf('/machines', 'GET')).toEqual([])
  })

  it('reads an unavailable settings endpoint as disabled with the transport code', async () => {
    answer(() => replies.http(405))
    await service.loadSettings()
    expect(store.machines.enabled).toBe(false)
    expect(store.machines.error).toBe('SSH_API_HTTP_405')
  })
})

describe('event polling', () => {
  beforeEach(async () => {
    wireList([machineA])
    await service.load()
  })

  it('folds a terminal banner into the log and drops empty lines', async () => {
    answer(call => call.url === `${API}/machines/events`
      ? replies.ok({ items: [
          { seq: 1, ts: '2025-09-01T00:00:00.000Z', machineId: 'a', stage: 'probe', line: '', terminal: 'failed', reason: 'port busy' },
          { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: '' },
        ] })
      : replies.ok({ items: [machineA], discovered: [] }))
    await service.poll()
    expect(store.machines.logs.a).toEqual(['[failed] port busy'])
  })

  it('folds the new lines past the per-machine cursor', async () => {
    answer(call => call.url === `${API}/machines/events`
      ? replies.ok({ items: [
          { seq: 1, ts: 't1', machineId: 'a', stage: 'probe', line: 'line 1' },
          { seq: 2, ts: 't2', machineId: 'a', stage: 'probe', line: 'line 2' },
        ] })
      : replies.ok({ items: [machineA], discovered: [] }))
    await service.poll()
    expect(store.machines.logs.a).toEqual(['line 1', 'line 2'])
    expect(paramsOf('/machines/events')).toEqual([{ machineId: 'a' }])

    sent.length = 0
    answer(call => call.url === `${API}/machines/events`
      ? replies.ok({ items: [{ seq: 3, ts: 't3', machineId: 'a', stage: 'probe', line: 'line 3' }] })
      : replies.ok({ items: [machineA], discovered: [] }))
    await service.poll()
    expect(store.machines.logs.a).toEqual(['line 1', 'line 2', 'line 3'])
    expect(paramsOf('/machines/events')).toEqual([{ machineId: 'a', sinceSeq: 2 }])
  })

  it('keeps an independent cursor per machine', async () => {
    wireList([{ ...machineA, state: 'connected' }, { ...machineB, state: 'connected' }])
    await service.load()
    sent.length = 0
    answer(call => call.url === `${API}/machines/events`
      ? replies.ok({ items: call.params.machineId === 'a'
          ? [{ seq: 10, ts: 't', machineId: 'a', stage: 'probe', line: 'a line' }]
          : [{ seq: 2, ts: 't', machineId: 'b', stage: 'probe', line: 'b line' }] })
      : replies.ok({ items: [{ ...machineA, state: 'connected' }, { ...machineB, state: 'connected' }], discovered: [] }))
    await service.poll()
    expect(paramsOf('/machines/events')).toEqual([{ machineId: 'a' }, { machineId: 'b' }])

    sent.length = 0
    await service.poll()
    expect(paramsOf('/machines/events')).toEqual([{ machineId: 'a', sinceSeq: 10 }, { machineId: 'b', sinceSeq: 2 }])
  })

  it('turns the channel off for good after a refusal', async () => {
    answer(call => call.url === `${API}/machines/events`
      ? replies.fail('unsupported')
      : replies.ok({ items: [machineA], discovered: [] }))
    await service.poll()
    expect(store.machines.error).toBeNull()
    sent.length = 0
    await service.poll()
    await service.poll()
    expect(paramsOf('/machines/events')).toEqual([])
  })
})

describe('notifications', () => {
  it('notifies the subscribers and stops after unsubscribe', async () => {
    const fire = vi.fn()
    const stop = store.machines.$subscribe(fire)
    wireList([machineA])
    await service.load()
    await tick()
    expect(fire).toHaveBeenCalled()

    stop()
    const calls = fire.mock.calls.length
    await service.load()
    await tick()
    expect(fire.mock.calls.length).toBe(calls)
  })
})

describe('the request layer is the only seam', () => {
  it('never reaches the wire outside the plugin API', async () => {
    wireList([machineA])
    await service.load()
    await api.getSessionRole()
    for (const call of sent)
      expect(call.url.startsWith(API)).toBe(true)
  })
})
