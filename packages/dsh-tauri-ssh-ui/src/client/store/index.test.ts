import type { FetchFn, MachineRow, SshApiResponse } from './index'
import { describe, expect, it, vi } from 'vitest'
import { machineEventsOf, machineRowOf, MachinesStore, mergeSyncResults, savePayloadOf, toggleSelection } from './index'

type FetchMock = ReturnType<typeof vi.fn<FetchFn>>

function fakeFetch(envelope: SshApiResponse): FetchMock {
  return vi.fn<FetchFn>(async () => ({ json: async () => envelope }) as unknown as Response)
}

function boot(envelope: SshApiResponse = { ok: true, value: { items: [] } }) {
  const fetchFn = fakeFetch(envelope)
  const store = new MachinesStore(fetchFn)
  return { store, fetchFn }
}

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

describe('machineRowOf', () => {
  it('parses a well-formed redacted row', () => {
    expect(machineRowOf(machineA)).toEqual(machineA)
    expect(machineRowOf(machineB)).toEqual(machineB)
  })

  it('rejects malformed rows', () => {
    expect(machineRowOf(undefined)).toBeUndefined()
    expect(machineRowOf('x')).toBeUndefined()
    expect(machineRowOf({ ...machineA, id: '' })).toBeUndefined()
    expect(machineRowOf({ ...machineA, id: 5 })).toBeUndefined()
    expect(machineRowOf({ ...machineA, name: 5 })).toBeUndefined()
    expect(machineRowOf({ ...machineA, host: '' })).toBeUndefined()
    expect(machineRowOf({ ...machineA, user: 5 })).toBeUndefined()
  })

  it('falls back to defaults for absent numeric fields and optional startCommand', () => {
    const row = machineRowOf({ ...machineA, port: undefined, remotePort: undefined, startCommand: '', hasPassword: undefined })
    expect(row).toMatchObject({ port: 22, remotePort: 3080, hasPassword: false })
    expect(row).not.toHaveProperty('startCommand')
  })

  it('accepts an empty user (resolved from ~/.ssh config or the OS user)', () => {
    const row = machineRowOf({ ...machineA, user: '' })
    expect(row).toMatchObject({ user: '' })
  })
})

describe('savePayloadOf', () => {
  it('builds the config row and carries only typed secrets', () => {
    expect(savePayloadOf(machineB, { passphrase: 'PHRASE', password: '' })).toEqual({
      machineId: 'b',
      row: {
        name: 'beta',
        host: '10.0.0.2',
        port: 2222,
        user: 'deploy',
        remotePort: 3000,
        startCommand: 'dsh web --host 127.0.0.1 --port 3000',
      },
      secrets: { passphrase: 'PHRASE' },
    })
    expect(savePayloadOf(machineA, {})).toEqual({
      machineId: 'a',
      row: { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
    })
    expect(savePayloadOf({ ...machineA, startCommand: '' }, {})).not.toHaveProperty('row.startCommand')
  })
})

describe('machinesStore', () => {
  it('loads machines, secret flags, and live statuses from machine.list', async () => {
    const { store } = boot({
      ok: true,
      value: {
        items: [
          { ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' },
          { ...machineB, state: 'disconnected', lastError: 'auth failed' },
          { ...machineA, id: 'c', name: 'gamma', state: 'disconnected' },
        ],
      },
    })
    await store.load()
    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.machines.map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(state.machines[0]).toMatchObject({ hasPassword: true, hasPassphrase: false })
    expect(state.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    expect(state.statuses.b).toEqual({ state: 'disconnected', lastError: 'auth failed' })
    expect(state.statuses.c).toEqual({ state: 'disconnected' })
  })

  it('carries the live progress of in-flight operations', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }] },
    })
    await store.load()
    expect(store.getSnapshot().statuses.a)
      .toEqual({ state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } })
  })

  it('accumulates the observed phase trail and clears it when the operation settles', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] },
    })
    await store.load()
    expect(store.getSnapshot().trails.a).toEqual(['handshake'])
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }] } }),
    } as unknown as Response)
    await store.poll()
    expect(store.getSnapshot().trails.a).toEqual(['handshake', 'starting'])
    // 同阶段重复不重复入轨
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }] } }),
    } as unknown as Response)
    await store.poll()
    expect(store.getSnapshot().trails.a).toEqual(['handshake', 'starting'])
    // 操作落定（progress 消失）清轨
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] } }),
    } as unknown as Response)
    await store.poll()
    expect(store.getSnapshot().trails.a).toBeUndefined()
  })

  it('polls without flipping the loading banner', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] },
    })
    await store.load()
    fetchFn.mockClear()
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] } }),
    } as unknown as Response)
    await store.poll()
    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' })
  })

  it('tolerates a list response without the items key', async () => {
    const { store } = boot({ ok: true, value: {} })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', machines: [], discovered: [], statuses: {} })
  })

  it('loads the discovered config aliases alongside the manual machines', async () => {
    const { store } = boot({
      ok: true,
      value: {
        items: [{ ...machineA, state: 'disconnected' }],
        discovered: [
          { ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root', hasPassword: false, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' },
          { ...machineA, id: 'ci', name: 'ci', host: 'ci', user: '', hasPassword: false, state: 'disconnected' },
        ],
      },
    })
    await store.load()
    const state = store.getSnapshot()
    expect(state.machines.map(row => row.id)).toEqual(['a'])
    expect(state.discovered.map(row => row.id)).toEqual(['dev', 'ci'])
    expect(state.discovered[0]).toMatchObject({ host: 'dev', user: 'root', hasPassword: false, hasPassphrase: false })
    expect(state.statuses.dev).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' })
    expect(state.statuses.ci).toEqual({ state: 'disconnected' })
  })

  it('reports a list failure as a page error', async () => {
    const { store } = boot({ ok: false, error: { code: 'forbidden', message: 'loopback only' } })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'loopback only' })
  })

  it('reports poll failures without flipping the ready status', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'forbidden', message: 'nope' } }) } as unknown as Response)
    await store.poll()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: 'nope' })
  })

  it('persists saves and removals through /api-ssh', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'disconnected' }, { ...machineB, state: 'disconnected' }] },
    })
    await store.load()
    fetchFn.mockClear()
    await store.persist(
      [{ ...machineA, name: 'alpha-2' }],
      { a: { password: 'sekrit', passphrase: 'PHRASE' } },
    )
    const calls = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
      .filter(call => call.method !== 'machine.list' && call.method !== 'session.role')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      method: 'machine.save',
      payload: {
        machineId: 'a',
        row: { name: 'alpha-2', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
        secrets: { password: 'sekrit', passphrase: 'PHRASE' },
      },
    })
    expect(calls[1]).toEqual({ method: 'machine.remove', payload: { machineId: 'b' } })
    expect(store.getSnapshot().error).toBeNull()
  })

  it('persists only manual machines, never the discovered aliases', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: {
        items: [{ ...machineA, state: 'disconnected' }],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected' }],
      },
    })
    await store.load()
    fetchFn.mockClear()
    await store.persist([machineA], {})
    const calls = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
      .filter(call => call.method !== 'machine.list' && call.method !== 'session.role')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'machine.save', payload: { machineId: 'a' } })
  })

  it('reports persist failures without throwing', async () => {
    const { store, fetchFn } = boot({ ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await store.load()
    fetchFn.mockClear()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'settings-rejected', message: 'nope' } }) } as unknown as Response)
    await store.persist([machineA], {})
    expect(store.getSnapshot().error).toBe('nope')
  })

  it('tests a machine and publishes the banner', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true, banner: 'Linux alpha' } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toEqual({ kind: 'text', text: 'Linux alpha' })
    expect(state.busy).toEqual({})
    const testCall = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload?: Record<string, unknown> })
      .find(call => call.method === 'machine.test')
    expect(testCall).toEqual({ method: 'machine.test', payload: { machineId: 'a' } })
  })

  it('falls back to defaults when a probe omits banner or message', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true } }) } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().notice).toEqual({ kind: 'key', key: 'notice.probe_ok' })
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: false } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toEqual({ kind: 'key', key: 'notice.probe_failed' })
    expect(state.statuses.a).toEqual({ state: 'disconnected', lastError: 'failed' })
  })

  it('publishes failed probes with the failure message', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: false, message: 'auth failed' } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toEqual({ kind: 'text', text: 'auth failed' })
    expect(state.statuses.a).toEqual({ state: 'disconnected', lastError: 'auth failed' })
  })

  it('never downgrades a live connection after a probe (regression)', async () => {
    // 探测是旁路健康检查，不触碰连接面：已连接的机器被点「测试」后必须
    // 保持 connected/tunnelBaseUrl，否则 UI 会把一条活连接显示成断开。
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:49152' } }) } as unknown as Response)
    await store.connect('a')
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true, banner: 'Linux alpha' } }) } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: false, message: 'auth failed' } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.statuses.a?.state).toBe('connected')
    expect(state.statuses.a?.lastError).toBe('auth failed')
  })

  it('connects, disconnects, and tracks busy state', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:49152' } }) } as unknown as Response)
    await store.connect('a')
    expect(store.getSnapshot().statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: {} }) } as unknown as Response)
    await store.disconnect('a')
    expect(store.getSnapshot().statuses.a).toEqual({ state: 'disconnected' })
    expect(store.getSnapshot().notice).toEqual({ kind: 'key', key: 'notice.disconnected' })
  })

  it('marks a machine busy while a connection-plane op is in flight', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fetchFn.mockReturnValueOnce(gate.then(() => ({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:1' } }) }) as unknown as Response))
    const pending = store.connect('a')
    expect(store.getSnapshot().busy.a).toBe('connect')
    release!()
    await pending
    expect(store.getSnapshot().busy).toEqual({})
  })

  it('reports connection-plane failures as a banner error', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'connect-failed', message: 'refused' } }) } as unknown as Response)
    await store.connect('a')
    expect(store.getSnapshot().error).toBe('refused')
    // 解析不了的信封（空响应体 / 非 JSON）归到稳定错误码，不外泄原生解析异常
    fetchFn.mockResolvedValueOnce({
      json: async () => {
        throw new Error('bad json')
      },
    } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().error).toBe('SSH_API_EMPTY')
    fetchFn.mockResolvedValueOnce({ ok: false, status: 405, json: async () => ({}) } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().error).toBe('SSH_API_HTTP_405')
    fetchFn.mockResolvedValueOnce({

      json: async () => {
        // eslint-disable-next-line no-throw-literal -- deliberately non-Error: covers messageOf(String(error))
        throw 'boom'
      },
    } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().error).toBe('SSH_API_EMPTY')
  })

  it('reads the feature switch and enables the SSH service', async () => {
    const { store, fetchFn } = boot({ ok: true, value: { enabled: false } })
    await store.loadSettings()
    expect(store.getSnapshot().enabled).toBe(false)

    // 未启用：机器列表请求不发（分区只渲染开启 Hero）
    await store.load()
    expect(store.getSnapshot().status).toBe('idle')

    fetchFn.mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string }
      const envelope = request.method === 'settings.set'
        ? { ok: true, value: { enabled: true } }
        : request.method === 'session.role'
          ? { ok: true, value: { remote: false } }
          : { ok: true, value: { enabled: true, items: [{ ...machineA, state: 'disconnected' }], discovered: [] } }
      return { json: async () => envelope } as unknown as Response
    })
    await store.enable()
    const state = store.getSnapshot()
    expect(state.enabled).toBe(true)
    expect(state.enabling).toBe(false)
    expect(state.machines.map(row => row.id)).toEqual(['a'])
  })

  it('treats an unavailable settings endpoint as switched off plus a transport code', async () => {
    const { store, fetchFn } = boot()
    fetchFn.mockResolvedValueOnce({ ok: false, status: 405, json: async () => ({}) } as unknown as Response)
    await store.loadSettings()
    expect(store.getSnapshot().enabled).toBe(false)
    expect(store.getSnapshot().error).toBe('SSH_API_HTTP_405')
  })

  it('carries the dshMissing marker on list rows', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true }] },
    })
    await store.load()
    const status = store.getSnapshot().statuses.a
    expect(status?.dshMissing).toBe(true)
    expect(status?.lastError).toBe('dsh is not installed')
  })

  it('installs dsh, records the outcome, and refreshes', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true } }),
    } as unknown as Response)
    await store.install('a')
    const state = store.getSnapshot()
    expect(state.installResults.a).toEqual({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true })
    // The follow-up load refreshed the list (auto-connect status).
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(state.busy).toEqual({})
  })

  it('reports an install failure as a banner error', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'machine-install-failed', message: 'pnpm: not found' } }) } as unknown as Response)
    await store.install('a')
    expect(store.getSnapshot().error).toBe('pnpm: not found')
  })

  it('exposes a uSES-compatible subscribe/getSnapshot seam', async () => {
    const { store } = boot()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.load()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    const before = listener.mock.calls.length
    await store.load()
    expect(listener.mock.calls.length).toBe(before)
    expect(store.getSnapshot()).toBe(store.store.getSnapshot())
  })
})

describe('connection-state vocabulary', () => {
  it('reads the C-STATE states, the retry instant, and the auth method', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'reconnecting', nextRetryAt: 1_700_000_008_000, authMethod: 'key' }] },
    })
    await store.load()
    expect(store.getSnapshot().statuses.a).toMatchObject({
      state: 'reconnecting',
      nextRetryAt: 1_700_000_008_000,
      authMethod: 'key',
    })
  })

  it('reads unknown wire states as disconnected', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'warping' }] },
    })
    await store.load()
    expect(store.getSnapshot().statuses.a?.state).toBe('disconnected')
  })
})

describe('machineEventsOf', () => {
  it('parses well-formed events and drops malformed ones', () => {
    expect(machineEventsOf({ events: [
      { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'probing' },
      { seq: 3, ts: '2025-09-01T00:00:02.000Z', machineId: 'a', stage: 'install', line: 'pnpm install', terminal: 'success' },
      { seq: 4, ts: '2025-09-01T00:00:03.000Z', machineId: 'a', stage: 'auth', line: 'gave up', terminal: 'failed', reason: 'auth failed' },
    ] })).toEqual([
      { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'probing' },
      { seq: 3, ts: '2025-09-01T00:00:02.000Z', machineId: 'a', stage: 'install', line: 'pnpm install', terminal: 'success' },
      { seq: 4, ts: '2025-09-01T00:00:03.000Z', machineId: 'a', stage: 'auth', line: 'gave up', terminal: 'failed', reason: 'auth failed' },
    ])
    expect(machineEventsOf(undefined)).toEqual([])
    expect(machineEventsOf({ events: 'nope' })).toEqual([])
    expect(machineEventsOf({ events: [{ machineId: 'a', line: 'x' }, 'junk'] })).toEqual([])
    // A numeric ts or boolean terminal (the draft shapes) is malformed now.
    expect(machineEventsOf({ events: [{ seq: 1, ts: 1_700_000_000, machineId: 'a', line: 'x' }] })).toEqual([])
    expect(machineEventsOf({ events: [{ seq: 1, ts: '2025-09-01T00:00:00.000Z', machineId: 'a', line: 'x', terminal: true }] })[0]).not.toHaveProperty('terminal')
  })
})

describe('event polling', () => {
  it('synthesizes a marker line for terminal events with an empty line', async () => {
    const fetchFn = eventsFetch({
      a: [[
        { seq: 1, ts: '2025-09-01T00:00:00.000Z', machineId: 'a', stage: 'launch', line: '' },
        { seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'launch', line: '', terminal: 'failed', reason: 'port busy' },
      ]],
    })
    const store = new MachinesStore(fetchFn)
    await store.load()
    await store.poll()
    // 无 terminal 的空行丢弃；带 terminal 的收尾事件落成可见标记行
    expect(store.getSnapshot().logs.a).toEqual(['[failed] port busy'])
  })
  /**
   * A fetch mock that answers machine.list (one machine per id) and
   * per-machine machine.events payloads, keyed by the polled machineId.
   */
  function eventsFetch(pagesByMachine: Record<string, unknown[][]>, listItems: MachineRow[] = [machineA]): FetchMock {
    const batchByMachine = new Map<string, number>()
    return vi.fn<FetchFn>(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string, payload?: { machineId?: string } }
      if (body.method === 'machine.events') {
        const machineId = body.payload?.machineId ?? ''
        const pages = pagesByMachine[machineId] ?? []
        const batch = batchByMachine.get(machineId) ?? 0
        batchByMachine.set(machineId, batch + 1)
        const events = pages[Math.min(batch, pages.length - 1)] ?? []
        return { json: async () => ({ ok: true, value: { events } }) } as unknown as Response
      }
      return { json: async () => ({ ok: true, value: { items: listItems.map(row => ({ ...row, state: 'connecting' })) } }) } as unknown as Response
    })
  }

  /** The machine.events calls a fetch mock saw, as parsed payloads. */
  function eventCallsOf(fetchFn: FetchMock): Array<{ machineId?: string, sinceSeq?: number }> {
    return fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload?: { machineId?: string, sinceSeq?: number } })
      .filter(call => call.method === 'machine.events')
      .map(call => call.payload ?? {})
  }

  it('folds event lines into the per-machine log tail past the per-machine cursor', async () => {
    const fetchFn = eventsFetch({
      a: [
        [
          { seq: 1, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'line 1' },
          { seq: 2, ts: '2025-09-01T00:00:02.000Z', machineId: 'a', stage: 'probe', line: 'line 2' },
        ],
        [
          { seq: 3, ts: '2025-09-01T00:00:03.000Z', machineId: 'a', stage: 'ready', line: 'line 3', terminal: 'success' },
        ],
      ],
    })
    const store = new MachinesStore(fetchFn)
    await store.poll()
    expect(store.getSnapshot().logs.a).toEqual(['line 1', 'line 2'])
    await store.poll()
    expect(store.getSnapshot().logs.a).toEqual(['line 1', 'line 2', 'line 3'])
    // The cursor rode along per machine: the second poll of machine a asked
    // for events after its own seq 2 (the first poll omitted sinceSeq).
    const calls = eventCallsOf(fetchFn)
    expect(calls[0]).toEqual({ machineId: 'a' })
    expect(calls[1]).toEqual({ machineId: 'a', sinceSeq: 2 })
  })

  it('advances each machine cursor in its own seq space', async () => {
    const fetchFn = eventsFetch({
      a: [[{ seq: 10, ts: '2025-09-01T00:00:01.000Z', machineId: 'a', stage: 'probe', line: 'a line' }]],
      b: [[{ seq: 2, ts: '2025-09-01T00:00:01.000Z', machineId: 'b', stage: 'auth', line: 'b line' }]],
    }, [machineA, machineB])
    const store = new MachinesStore(fetchFn)
    await store.poll()
    expect(store.getSnapshot().logs.a).toEqual(['a line'])
    expect(store.getSnapshot().logs.b).toEqual(['b line'])
    // Both machines polled from the start on the first round; machine a's
    // high seq must not starve machine b's lower seq space.
    const firstRound = eventCallsOf(fetchFn)
    expect(firstRound).toContainEqual({ machineId: 'a' })
    expect(firstRound).toContainEqual({ machineId: 'b' })
    await store.poll()
    const secondRound = eventCallsOf(fetchFn).slice(firstRound.length)
    expect(secondRound).toContainEqual({ machineId: 'a', sinceSeq: 10 })
    expect(secondRound).toContainEqual({ machineId: 'b', sinceSeq: 2 })
  })

  it('turns the channel off after the host refuses it once', async () => {
    const fetchFn = vi.fn<FetchFn>(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method === 'machine.events') {
        return { json: async () => ({ ok: false, error: { code: 'unknown-method', message: 'unknown method "machine.events"' } }) } as unknown as Response
      }
      return { json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connecting' }] } }) } as unknown as Response
    })
    const store = new MachinesStore(fetchFn)
    await store.poll()
    await store.poll()
    await store.poll()
    const eventsCalls = fetchFn.mock.calls
      .filter(call => (JSON.parse(String(call[1]?.body)) as { method: string }).method === 'machine.events')
    expect(eventsCalls).toHaveLength(1)
    // The refusal never fails the page.
    expect(store.getSnapshot().error).toBeNull()
  })
})

describe('toggleSelection', () => {
  it('toggles membership independently per key', () => {
    let selected = toggleSelection(new Set(), 'a')
    selected = toggleSelection(selected, 'b')
    expect([...selected].sort()).toEqual(['a', 'b'])
    selected = toggleSelection(selected, 'a')
    expect([...selected].sort()).toEqual(['b'])
  })
})

describe('sync state', () => {
  /** A fetch mock answering per method. */
  function syncFetch(routes: Record<string, unknown>): FetchMock {
    return vi.fn<FetchFn>(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      return { json: async () => ({ ok: true, value: routes[body.method] ?? {} }) } as unknown as Response
    })
  }

  it('loads the preview into the sync slice', async () => {
    const store = new MachinesStore(syncFetch({
      'sync.preview': { plugins: [{ name: 'p', spec: 'github:a/b', syncable: true }], skills: [{ name: 's', root: 'dsh' }] },
    }))
    await store.loadSyncPreview()
    expect(store.getSnapshot().sync).toMatchObject({
      status: 'ready',
      preview: {
        plugins: [{ name: 'p', spec: 'github:a/b', syncable: true }],
        skills: [{ name: 's', root: 'dsh' }],
      },
    })
  })

  it('settles a preview failure as the sync error state', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ json: async () => ({ ok: false, error: { code: 'internal', message: 'nope' } }) }) as unknown as Response)
    const store = new MachinesStore(fetchFn)
    await store.loadSyncPreview()
    expect(store.getSnapshot().sync).toMatchObject({ status: 'error', error: 'nope' })
  })

  it('applies a selection and lands the per-item results', async () => {
    const fetchFn = syncFetch({
      'sync.apply': { items: [
        { kind: 'plugin', name: 'p', ok: true },
        { kind: 'skill', name: 's', root: 'dsh', ok: false, error: 'exit 1' },
      ] },
    })
    const store = new MachinesStore(fetchFn)
    await store.applySync('a', [{ name: 'p', spec: 'github:a/b', syncable: true }], [{ name: 's', root: 'dsh' }])
    const sync = store.getSnapshot().sync
    expect(sync.applying).toBe(false)
    expect(sync.error).toBeNull()
    expect(sync.results).toEqual([
      { kind: 'plugin', name: 'p', ok: true },
      { kind: 'skill', name: 's', root: 'dsh', ok: false, error: 'exit 1' },
    ])
    const applyCall = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
      .find(call => call.method === 'sync.apply')
    expect(applyCall?.payload).toEqual({
      machineId: 'a',
      plugins: [{ name: 'p', spec: 'github:a/b' }],
      skills: [{ name: 's', root: 'dsh' }],
    })
  })

  it('settles an apply failure as the sync error without losing applying=false', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ json: async () => ({ ok: false, error: { code: 'machine-sync-failed', message: 'ssh down' } }) }) as unknown as Response)
    const store = new MachinesStore(fetchFn)
    await store.applySync('a', [{ name: 'p', spec: 'github:a/b', syncable: true }], [])
    expect(store.getSnapshot().sync).toMatchObject({ applying: false, error: 'ssh down' })
  })

  it('merges a retry batch over its own entries and appends new ones', async () => {
    const fetchFn = syncFetch({
      'sync.apply': { items: [
        { kind: 'plugin', name: 'p', ok: false, error: 'exit 1' },
        { kind: 'skill', name: 's', root: 'dsh', ok: true },
      ] },
    })
    const store = new MachinesStore(fetchFn)
    await store.applySync('a', [{ name: 'p', spec: 'github:a/b', syncable: true }], [{ name: 's', root: 'dsh' }])
    // 重试 p：成功，且 s 的既有结论不被抹掉
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { items: [{ kind: 'plugin', name: 'p', ok: true }] } }) } as unknown as Response)
    await store.applySync('a', [{ name: 'p', spec: 'github:a/b', syncable: true }], [])
    expect(store.getSnapshot().sync.results).toEqual([
      { kind: 'plugin', name: 'p', ok: true },
      { kind: 'skill', name: 's', root: 'dsh', ok: true },
    ])
  })
})

describe('mergeSyncResults', () => {
  const ok = (name: string): { kind: 'plugin', name: string, ok: boolean } => ({ kind: 'plugin', name, ok: true })

  it('keeps the first-seen order and replaces in place', () => {
    const merged = mergeSyncResults([ok('a'), ok('b')], [{ kind: 'plugin', name: 'b', ok: false, error: 'boom' }])
    expect(merged).toEqual([ok('a'), { kind: 'plugin', name: 'b', ok: false, error: 'boom' }])
  })

  it('appends unseen items and separates skills by root', () => {
    const merged = mergeSyncResults(
      [{ kind: 'skill', name: 'alpha', root: 'dsh', ok: true }],
      [{ kind: 'skill', name: 'alpha', root: 'agents', ok: false }, ok('c')],
    )
    expect(merged.map(item => `${item.kind}:${item.root ?? ''}:${item.name}`)).toEqual([
      'skill:dsh:alpha',
      'skill:agents:alpha',
      'plugin::c',
    ])
  })
})
