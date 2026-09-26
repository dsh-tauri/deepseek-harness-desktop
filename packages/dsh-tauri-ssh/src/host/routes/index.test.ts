import type { MachineView, SshTestResult } from '../types/index'
import type { SshApiHost, SshApiResponse } from './index'
import { Buffer } from 'node:buffer'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { SshMachineEvents } from '../service/events'
import { MachineId, SshError } from '../types/index'
import { createSshApiHandler, isLoopbackPeer } from './index'

const view: MachineView = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}

/** A seeded per-machine event log shared by the fake host. */
const log = new SshMachineEvents()
log.append(MachineId('m1'), 'probe', '探测远端平台 (uname -srm)')
log.append(MachineId('m1'), 'download', 'https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
log.append(MachineId('m1'), 'ready', '远端实例已就绪', { terminal: 'success' })

function fakeHost(overrides: Partial<SshApiHost> = {}): SshApiHost {
  return {
    sessionRole: () => ({ remote: false }),
    enabled: () => true,
    setEnabled: async () => {},
    profileViews: () => [view],
    discoveredViews: async () => [],
    status: () => ({ machineId: MachineId('m1'), state: 'disconnected' }),
    test: async (): Promise<SshTestResult> => ({ ok: true, banner: 'Linux alpha' }),
    connect: async () => ({ tunnelBaseUrl: 'http://127.0.0.1:45678' }),
    disconnect: async () => {},
    install: async () => ({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true }),
    events: (machineId, sinceSeq) => log.since(machineId, sinceSeq),
    save: async () => {},
    remove: async () => {},
    syncPreview: () => ({ plugins: [], skills: [] }),
    syncApply: async () => ({ items: [] }),
    ...overrides,
  }
}

/** Drive one request through the handler and collect the response. */
async function call(
  host: SshApiHost,
  body: string,
  options: { method?: string, address?: string, origin?: string } = {},
): Promise<{ status: number, body: SshApiResponse, headers: Record<string, unknown> }> {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: options.address ?? '127.0.0.1', configurable: true })
  const req = new IncomingMessage(socket)
  req.method = options.method ?? 'POST'
  if (options.origin !== undefined)
    req.headers.origin = options.origin
  const res = new ServerResponse(req)
  let status = 0
  let payload = ''
  let headers: Record<string, unknown> = {}
  res.writeHead = ((code: number, head?: Record<string, unknown>) => {
    status = code
    headers = head ?? {}
    return res
  }) as typeof res.writeHead
  res.end = ((chunk?: unknown) => {
    payload = String(chunk ?? '')
    return res
  }) as typeof res.end
  // Feed the body through the readable stream.
  req.push(Buffer.from(body))
  req.push(null)
  await createSshApiHandler(host)(req, res)
  // 204 preflight responses carry no body; parse only actual JSON payloads.
  return { status, body: (payload === '' ? {} : JSON.parse(payload)) as SshApiResponse, headers }
}

describe('isLoopbackPeer', () => {
  it('accepts loopback addresses and rejects everything else', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('192.168.1.5')).toBe(false)
    expect(isLoopbackPeer(undefined)).toBe(false)
  })
})

describe('/api-ssh handler', () => {
  it('answers the shell webview\'s CORS preflight and echoes its origin', async () => {
    const { status, headers } = await call(fakeHost(), '', { method: 'OPTIONS', origin: 'http://localhost:1420' })
    expect(status).toBe(204)
    expect(headers['access-control-allow-origin']).toBe('http://localhost:1420')
    expect(headers['access-control-allow-methods']).toBe('POST, OPTIONS')
  })

  it('allows every Tauri shell scheme origin on preflight', async () => {
    for (const origin of ['tauri://localhost', 'http://tauri.localhost']) {
      const { status, headers } = await call(fakeHost(), '', { method: 'OPTIONS', origin })
      expect(status).toBe(204)
      expect(headers['access-control-allow-origin']).toBe(origin)
    }
  })

  it('refuses preflight from a non-shell origin', async () => {
    const { status, body, headers } = await call(fakeHost(), '', { method: 'OPTIONS', origin: 'http://evil.example' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(headers['access-control-allow-origin']).toBeUndefined()
  })

  it('carries the CORS headers on cross-origin POST responses for shell origins only', async () => {
    const allowed = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }), { origin: 'tauri://localhost' })
    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('tauri://localhost')
    const rogue = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }), { origin: 'http://evil.example' })
    expect(rogue.status).toBe(200)
    expect(rogue.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('refuses non-loopback peers', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }), { address: '10.0.0.9' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses non-POST methods', async () => {
    const { status, body } = await call(fakeHost(), '', { method: 'GET' })
    expect(status).toBe(405)
    expect(body).toMatchObject({ ok: false, error: { code: 'method-not-allowed' } })
  })

  it('rejects malformed JSON and missing methods', async () => {
    const bad = await call(fakeHost(), 'not json')
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const missing = await call(fakeHost(), JSON.stringify({ payload: {} }))
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('answers session.role from the host', async () => {
    const plain = await call(fakeHost(), JSON.stringify({ method: 'session.role' }))
    expect(plain.body).toEqual({ ok: true, value: { remote: false } })
    const remote = await call(fakeHost({ sessionRole: () => ({ remote: true, origin: 'ops' }) }), JSON.stringify({ method: 'session.role' }))
    expect(remote.body).toEqual({ ok: true, value: { remote: true, origin: 'ops' } })
  })

  it('reads and writes the SSH feature switch', async () => {
    const setEnabled = vi.fn(async () => {})
    const off = fakeHost({ enabled: () => false, setEnabled })
    expect((await call(off, JSON.stringify({ method: 'settings.get' }))).body)
      .toEqual({ ok: true, value: { enabled: false } })

    const written = await call(off, JSON.stringify({ method: 'settings.set', payload: { enabled: true } }))
    expect(written.status).toBe(200)
    expect(written.body).toEqual({ ok: true, value: { enabled: true } })
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  it('refuses a settings.set without a boolean switch', async () => {
    const setEnabled = vi.fn(async () => {})
    const host = fakeHost({ setEnabled })
    const { body } = await call(host, JSON.stringify({ method: 'settings.set', payload: {} }))
    expect(body).toMatchObject({ ok: false, error: { message: 'missing enabled' } })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('serves no machines while the feature is off (keeps the flag visible)', async () => {
    const host = fakeHost({
      enabled: () => false,
      profileViews: () => [view],
      discoveredViews: async () => [view],
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { enabled: false, items: [], discovered: [] } })
  })

  it('lists machines with live status', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1', lastError: 'boom' }),
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        enabled: true,
        items: [{
          ...view,
          state: 'connected',
          tunnelBaseUrl: 'http://127.0.0.1:1',
          lastError: 'boom',
        }],
        discovered: [],
      },
    })
  })

  it('lists discovered config aliases with their live status', async () => {
    const host = fakeHost({
      discoveredViews: async () => [{
        id: MachineId('dev'),
        name: 'dev',
        host: 'dev',
        port: 22,
        user: '',
        hasPassword: false,
        hasPassphrase: false,
        remotePort: 3080,
      }],
      status: (id: MachineId) => id === MachineId('dev')
        ? { machineId: id, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:2' }
        : { machineId: id, state: 'disconnected' },
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        enabled: true,
        items: [{ ...view, state: 'disconnected' }],
        discovered: [{
          id: 'dev',
          name: 'dev',
          host: 'dev',
          port: 22,
          user: '',
          hasPassword: false,
          hasPassphrase: false,
          remotePort: 3080,
          state: 'connected',
          tunnelBaseUrl: 'http://127.0.0.1:2',
        }],
      },
    })
  })

  it('rides the live progress of an in-flight operation on list rows', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }),
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        enabled: true,
        items: [{
          ...view,
          state: 'connecting',
          progress: { phase: 'probing', attempt: 2, total: 30 },
        }],
        discovered: [],
      },
    })
  })

  it('lists machines without link fields while disconnected', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { enabled: true, items: [{ ...view, state: 'disconnected' }], discovered: [] } })
  })

  it('rejects request bodies over the 64 KiB bound', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list', payload: { pad: 'x'.repeat(70 * 1024) } }))
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('tests a machine', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { ok: true, banner: 'Linux alpha' } })
  })

  it('connects a machine and returns the tunnel URL', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:45678' } })
  })

  it('saves a machine with write-only secrets', async () => {
    const save = vi.fn(async () => {})
    const host = fakeHost({ save })
    const { status, body } = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: {
          name: 'alpha',
          host: '10.0.0.1',
          port: 22,
          user: 'root',
          remotePort: 3000,
          startCommand: 'dsh web --port 3000',
        },
        secrets: { password: 'PW', passphrase: 'PHRASE' },
      },
    }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      {
        name: 'alpha',
        host: '10.0.0.1',
        port: 22,
        user: 'root',
        remotePort: 3000,
        startCommand: 'dsh web --port 3000',
      },
      { password: 'PW', passphrase: 'PHRASE' },
    )
  })

  it('rejects malformed machine.save payloads', async () => {
    const save = vi.fn(async () => {})
    const host = fakeHost({ save })
    const missingRow = await call(host, JSON.stringify({ method: 'machine.save', payload: { machineId: 'm1' } }))
    expect(missingRow.body).toEqual({ ok: false, error: { code: 'internal', message: 'missing row' } })
    const badName = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: '', host: 'x', user: 'u' } },
    }))
    expect(badName.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: name' } })
    const badUserType = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 7 } },
    }))
    expect(badUserType.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: user' } })
    const badHost = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: '', user: 'u' } },
    }))
    expect(badHost.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: host' } })
    const badSecrets = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 'u' }, secrets: 'nope' },
    }))
    expect(badSecrets.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid secrets' } })
    expect(save).not.toHaveBeenCalled()
  })

  it('applies row defaults for absent numeric fields', async () => {
    const save = vi.fn(async () => {})
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 'u', startCommand: '' } },
    }))
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      undefined,
    )
  })

  it('drops absent secret fields', async () => {
    const save = vi.fn(async () => {})
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: { name: 'a', host: 'x', user: 'u' },
        secrets: { passphrase: 'PHRASE' },
      },
    }))
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { passphrase: 'PHRASE' },
    )
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: { name: 'a', host: 'x', user: 'u' },
        secrets: { password: 'P' },
      },
    }))
    expect(save).toHaveBeenLastCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { password: 'P' },
    )
  })

  it('removes a machine', async () => {
    const remove = vi.fn(async () => {})
    const host = fakeHost({ remove })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.remove', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
    expect(remove).toHaveBeenCalledWith(MachineId('m1'))
  })

  it('disconnects a machine', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.disconnect', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
  })

  it('installs dsh on a machine and returns the outcome', async () => {
    const install = vi.fn(async () => ({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true }))
    const host = fakeHost({ install })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.install', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: { installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true },
    })
    expect(install).toHaveBeenCalledWith(MachineId('m1'), expect.any(AbortSignal))
  })

  it('surfaces install failures on the envelope', async () => {
    const host = fakeHost({
      install: async () => { throw new SshError('machine-install-failed', MachineId('m1'), 'pnpm: not found') },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.install', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'machine-install-failed', message: 'pnpm: not found' } })
  })

  it('carries the dshMissing marker on list rows', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'disconnected', dshMissing: true }),
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(body).toMatchObject({ ok: true })
    const value = (body as { ok: true, value: { items: Array<Record<string, unknown>> } }).value
    expect(value.items[0]).toMatchObject({ dshMissing: true })
  })

  it('maps business failures onto the envelope', async () => {
    const host = fakeHost({
      test: async () => { throw new SshError('machine-connect-failed', MachineId('m1'), 'auth failed') },
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: false, error: { code: 'machine-connect-failed', message: 'auth failed' } })
  })

  it('maps plain failures onto internal', async () => {
    const host = fakeHost({
      connect: async () => { throw new Error('tunnel broken') },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'tunnel broken' } })
  })

  it('maps non-Error failures onto internal', async () => {
    const host = fakeHost({

      test: async () => {
        // eslint-disable-next-line no-throw-literal -- deliberately non-Error: covers failureOf's String(error) arm
        throw 'boom'
      },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
  })

  it('requires a machineId on actions', async () => {
    const { body } = await call(fakeHost(), JSON.stringify({ method: 'machine.test', payload: {} }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'missing machineId' } })
  })

  it('serves the sync preview', async () => {
    const preview = {
      plugins: [{ name: 'dsh-market', spec: 'github:a/b', syncable: true }],
      skills: [{ name: 'alpha', root: 'dsh' as const }],
    }
    const host = fakeHost({ syncPreview: () => preview })
    const { status, body } = await call(host, JSON.stringify({ method: 'sync.preview' }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: preview })
  })

  it('applies a sync selection and returns per-item results', async () => {
    const syncApply = vi.fn(async () => ({
      items: [
        { kind: 'plugin' as const, name: 'dsh-market', ok: true },
        { kind: 'skill' as const, name: 'alpha', root: 'dsh' as const, ok: false, error: 'exit 1: read-only' },
      ],
    }))
    const host = fakeHost({ syncApply })
    const { status, body } = await call(host, JSON.stringify({
      method: 'sync.apply',
      payload: {
        machineId: 'm1',
        plugins: [{ name: 'dsh-market', spec: 'github:a/b' }],
        skills: [{ name: 'alpha', root: 'dsh' }],
      },
    }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true })
    expect(syncApply).toHaveBeenCalledWith(
      MachineId('m1'),
      [{ name: 'dsh-market', spec: 'github:a/b' }],
      [{ name: 'alpha', root: 'dsh' }],
    )
    const value = (body as { ok: true, value: { items: Array<Record<string, unknown>> } }).value
    expect(value.items).toHaveLength(2)
    expect(value.items[1]).toMatchObject({ ok: false, error: 'exit 1: read-only' })
  })

  it('defaults an absent sync selection to empty lists', async () => {
    const syncApply = vi.fn(async () => ({ items: [] }))
    const host = fakeHost({ syncApply })
    const { body } = await call(host, JSON.stringify({ method: 'sync.apply', payload: { machineId: 'm1' } }))
    expect(body).toMatchObject({ ok: true })
    expect(syncApply).toHaveBeenCalledWith(MachineId('m1'), [], [])
  })

  it('rejects malformed sync selections', async () => {
    const badPlugin = await call(fakeHost(), JSON.stringify({
      method: 'sync.apply',
      payload: { machineId: 'm1', plugins: [{ name: 'x' }] },
    }))
    expect(badPlugin.body).toMatchObject({ ok: false, error: { message: 'invalid plugin ref' } })

    const badRoot = await call(fakeHost(), JSON.stringify({
      method: 'sync.apply',
      payload: { machineId: 'm1', skills: [{ name: 'x', root: 'elsewhere' }] },
    }))
    expect(badRoot.body).toMatchObject({ ok: false, error: { message: 'invalid skill ref: root' } })

    const notArray = await call(fakeHost(), JSON.stringify({
      method: 'sync.apply',
      payload: { machineId: 'm1', plugins: 'nope' },
    }))
    expect(notArray.body).toMatchObject({ ok: false, error: { message: 'invalid plugins' } })
  })

  it('rejects unknown methods', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.warp' }))
    expect(status).toBe(404)
    expect(body).toMatchObject({ ok: false, error: { code: 'unknown-method' } })
  })
  it('drains machine events from the beginning', async () => {
    const response = await call(fakeHost(), JSON.stringify({ method: 'machine.events', payload: { machineId: 'm1' } }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      value: {
        events: [
          expect.objectContaining({ seq: 1, stage: 'probe' }),
          expect.objectContaining({ seq: 2, stage: 'download' }),
          expect.objectContaining({ seq: 3, stage: 'ready', terminal: 'success' }),
        ],
        nextSeq: 4,
      },
    })
  })

  it('drains machine events incrementally by sinceSeq', async () => {
    const response = await call(fakeHost(), JSON.stringify({ method: 'machine.events', payload: { machineId: 'm1', sinceSeq: 2 } }))
    expect(response.body).toMatchObject({
      ok: true,
      value: {
        events: [expect.objectContaining({ seq: 3 })],
        nextSeq: 4,
      },
    })
  })

  it('reports unknown event machines as an empty page anchored at seq 1', async () => {
    const response = await call(fakeHost(), JSON.stringify({ method: 'machine.events', payload: { machineId: 'ghost' } }))
    expect(response.body).toEqual({ ok: true, value: { events: [], nextSeq: 1 } })
  })

  it('rejects malformed event cursors', async () => {
    const response = await call(fakeHost(), JSON.stringify({ method: 'machine.events', payload: { machineId: 'm1', sinceSeq: -1 } }))
    expect(response.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid sinceSeq' } })
    const missing = await call(fakeHost(), JSON.stringify({ method: 'machine.events', payload: {} }))
    expect(missing.body).toEqual({ ok: false, error: { code: 'internal', message: 'missing machineId' } })
  })
})
