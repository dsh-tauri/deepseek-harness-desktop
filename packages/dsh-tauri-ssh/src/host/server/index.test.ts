import type { HostWebRoute, MachineView, SshMachineStatus, SshTestResult, SyncPreview } from '../types/index'
import type { SshActionResponse, SshConnectResponse, SshInstallResponse, SshMachineEventsResponse, SshMachinesResponse, SshSessionRoleResponse, SshSettingsResponse, SshTestResponse, SyncApplyResponse, SyncPreviewResponse } from './routes/index.types'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { events } from '../service/events'
import { machine } from '../service/machine'
import { session } from '../service/session'
import { sync } from '../service/sync'
import { MachineId, SshError } from '../types/index'
import { server } from './index'

const BASE = '/api/tauri/ssh'

const PATHS = [
  `${BASE}/settings`,
  `${BASE}/session/role`,
  `${BASE}/machines`,
  `${BASE}/machines/test`,
  `${BASE}/machines/connect`,
  `${BASE}/machines/disconnect`,
  `${BASE}/machines/install`,
  `${BASE}/machines/events`,
  `${BASE}/sync/preview`,
  `${BASE}/sync/apply`,
]

const ALLOW: Record<string, string> = {
  [`${BASE}/settings`]: 'GET, HEAD, POST',
  [`${BASE}/session/role`]: 'GET, HEAD',
  [`${BASE}/machines`]: 'GET, HEAD, POST, DELETE',
  [`${BASE}/machines/test`]: 'POST',
  [`${BASE}/machines/connect`]: 'POST',
  [`${BASE}/machines/disconnect`]: 'POST',
  [`${BASE}/machines/install`]: 'POST',
  [`${BASE}/machines/events`]: 'GET, HEAD',
  [`${BASE}/sync/preview`]: 'GET, HEAD',
  [`${BASE}/sync/apply`]: 'POST',
}

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

interface HostFakes {
  sessionRole: () => { remote: boolean, origin?: string }
  enabled: () => boolean
  setEnabled: (enabled: boolean) => Promise<void>
  profileViews: () => MachineView[]
  discoveredViews: () => Promise<MachineView[]>
  status: (machineId: MachineId) => SshMachineStatus
  test: (machineId: MachineId, signal?: AbortSignal) => Promise<SshTestResult>
  connect: (machineId: MachineId, signal?: AbortSignal) => Promise<{ machineId: MachineId, tunnelBaseUrl: string }>
  disconnect: (machineId: MachineId) => Promise<void>
  install: (machineId: MachineId, signal?: AbortSignal) => Promise<SshInstallResponse>
  events: (machineId: MachineId, sinceSeq?: number) => { events: unknown[], nextSeq: number }
  save: (machineId: MachineId, row: Record<string, unknown>, secrets?: Record<string, unknown>) => Promise<void>
  remove: (machineId: MachineId) => Promise<void>
  syncPreview: () => SyncPreview
  syncApply: (machineId: MachineId, plugins: unknown[], skills: unknown[]) => Promise<SyncApplyResponse>
}

const log = events
const readEvents = events.since
log.append(MachineId('m1'), 'probe', '探测远端平台 (uname -srm)')
log.append(MachineId('m1'), 'download', 'https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
log.append(MachineId('m1'), 'ready', '远端实例已就绪', { terminal: 'success' })

function fakeHost(overrides: Partial<HostFakes> = {}): HostFakes {
  return {
    sessionRole: () => ({ remote: false }),
    enabled: () => true,
    setEnabled: async () => {},
    profileViews: () => [view],
    discoveredViews: async () => [],
    status: () => ({ machineId: MachineId('m1'), state: 'disconnected' }),
    test: async (): Promise<SshTestResult> => ({ ok: true, banner: 'Linux alpha' }),
    connect: async (machineId): Promise<{ machineId: MachineId, tunnelBaseUrl: string }> => ({ machineId, tunnelBaseUrl: 'http://127.0.0.1:45678' }),
    disconnect: async () => {},
    install: async () => ({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true }),
    events: (machineId, sinceSeq) => readEvents(machineId, sinceSeq),
    save: async () => {},
    remove: async () => {},
    syncPreview: () => ({ plugins: [], skills: [] }),
    syncApply: async () => ({ items: [] }),
    ...overrides,
  }
}

const originalServices = {
  events: { ...events },
  machine: { ...machine },
  session: { ...session },
  sync: { ...sync },
}

function installHost(host: HostFakes): void {
  Object.assign(session, { role: host.sessionRole })
  Object.assign(machine, {
    enabled: host.enabled,
    setEnabled: host.setEnabled,
    profileViews: host.profileViews,
    discoveredViews: host.discoveredViews,
    status: host.status,
    test: host.test,
    connect: host.connect,
    disconnect: host.disconnect,
    install: host.install,
    save: host.save,
    remove: host.remove,
  })
  Object.assign(events, { since: host.events })
  Object.assign(sync, { preview: host.syncPreview, apply: host.syncApply })
}

const registered: HostWebRoute[] = []
let origin = ''
let disposeRoutes: () => void
let closeServer: () => Promise<void>

function serveRoutes(): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.find(entry => entry.path === path)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"no-route"}')
      return
    }
    void route.handler(request, response)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        origin: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

beforeAll(async () => {
  disposeRoutes = server({
    webServer: {
      register: (route: HostWebRoute) => {
        registered.push(route)
        return () => {
          registered.splice(registered.indexOf(route), 1)
        }
      },
    },
    logger: { error: () => {} },
  } as never)
  const listener = await serveRoutes()
  origin = listener.origin
  closeServer = listener.close
})

afterEach(() => {
  Object.assign(events, originalServices.events)
  Object.assign(machine, originalServices.machine)
  Object.assign(session, originalServices.session)
  Object.assign(sync, originalServices.sync)
})

afterAll(async () => {
  disposeRoutes()
  await closeServer()
})

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number, body: T, allow: string | undefined }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as T,
    allow: response.headers.get('allow') ?? undefined,
  }
}

describe('ssh REST route table', () => {
  it('declares one exact route per endpoint and disposes every registration', () => {
    const declared: string[] = []
    const disposed: string[] = []
    const dispose = server({
      webServer: {
        register: (route: HostWebRoute) => {
          declared.push(`${route.kind} ${route.path}`)
          return () => {
            disposed.push(route.path)
          }
        },
      },
      logger: { error: () => {} },
    } as never)
    expect(declared).toEqual(PATHS.map(path => `exact ${path}`))
    dispose()
    expect([...disposed].sort()).toEqual([...PATHS].sort())
  })

  it('refuses undeclared OPTIONS with native 405 and each endpoint method set', async () => {
    for (const path of PATHS) {
      const reply = await call('OPTIONS', path)
      expect(reply.status).toBe(405)
      expect(reply.allow?.split(', ').sort()).toEqual(ALLOW[path].split(', ').sort())
    }
  })

  it('refuses undeclared methods with 405 and the same allow set', async () => {
    const put = await call('PUT', `${BASE}/settings`)
    expect(put.status).toBe(405)
    expect(put.allow?.split(', ').sort()).toEqual(ALLOW[`${BASE}/settings`].split(', ').sort())
    const preview = await call('POST', `${BASE}/sync/preview`)
    expect(preview.status).toBe(405)
    expect(preview.allow?.split(', ').sort()).toEqual(ALLOW[`${BASE}/sync/preview`].split(', ').sort())
    const install = await call('GET', `${BASE}/machines/install`)
    expect(install.status).toBe(405)
    expect(install.allow?.split(', ').sort()).toEqual(ALLOW[`${BASE}/machines/install`].split(', ').sort())
  })
})

describe('ssh REST handlers', () => {
  it('answers session.role from the host', async () => {
    installHost(fakeHost())
    const plain = await call<SshSessionRoleResponse>('GET', `${BASE}/session/role`)
    expect(plain.status).toBe(200)
    expect(plain.body).toEqual({ role: 'local', remote: false })
    installHost(fakeHost({ sessionRole: () => ({ remote: true, origin: 'ops' }) }))
    const remote = await call<SshSessionRoleResponse>('GET', `${BASE}/session/role`)
    expect(remote.body).toEqual({ role: 'remote', remote: true, origin: 'ops' })
  })

  it('reads and writes the SSH feature switch', async () => {
    const setEnabled = vi.fn(async () => {})
    const host = fakeHost({ enabled: () => false, setEnabled })
    installHost(host)
    const read = await call<SshSettingsResponse>('GET', `${BASE}/settings`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ enabled: false })

    const written = await call<SshSettingsResponse>('POST', `${BASE}/settings`, { enabled: true })
    expect(written.status).toBe(200)
    expect(written.body).toEqual({ enabled: true })
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  it('refuses a settings write without a boolean switch', async () => {
    const setEnabled = vi.fn(async () => {})
    installHost(fakeHost({ setEnabled }))
    const reply = await call<SshSettingsResponse>('POST', `${BASE}/settings`, {})
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({ error: 'missing enabled' })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('rejects a malformed JSON body', async () => {
    installHost(fakeHost())
    const response = await fetch(`${origin}${BASE}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })

  it('serves no machines while the feature is off (keeps the flag visible)', async () => {
    installHost(fakeHost({ enabled: () => false, profileViews: () => [view], discoveredViews: async () => [view] }))
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ enabled: false, items: [], discovered: [] })
  })

  it('lists machines with live status', async () => {
    installHost(fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1', lastError: 'boom' }),
    }))
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      enabled: true,
      items: [{ ...view, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1', lastError: 'boom' }],
      discovered: [],
    })
  })

  it('lists discovered config aliases with their live status', async () => {
    installHost(fakeHost({
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
    }))
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
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
    })
  })

  it('rides the live progress of an in-flight operation on list rows', async () => {
    installHost(fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }),
    }))
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      enabled: true,
      items: [{ ...view, state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }],
      discovered: [],
    })
  })

  it('lists machines without link fields while disconnected', async () => {
    installHost(fakeHost())
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ enabled: true, items: [{ ...view, state: 'disconnected' }], discovered: [] })
  })

  it('carries the dshMissing marker on list rows', async () => {
    installHost(fakeHost({ status: () => ({ machineId: MachineId('m1'), state: 'disconnected', dshMissing: true }) }))
    const reply = await call<SshMachinesResponse>('GET', `${BASE}/machines`)
    expect(reply.body.items?.[0]).toMatchObject({ dshMissing: true })
  })

  it('passes a JSON body over the removed desktop bound to the service', async () => {
    const save = vi.fn(async () => {})
    installHost(fakeHost({ save }))
    const password = 'p'.repeat(2 * 1024 * 1024)
    const reply = await call<SshActionResponse>('POST', `${BASE}/machines`, {
      machineId: 'm1',
      row: { name: 'alpha', host: '10.0.0.1', user: 'root' },
      secrets: { password },
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({})
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
      { password },
    )
  })

  it('tests a machine', async () => {
    installHost(fakeHost())
    const reply = await call<SshTestResponse>('POST', `${BASE}/machines/test`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, banner: 'Linux alpha' })
  })

  it('connects a machine and returns the tunnel URL', async () => {
    installHost(fakeHost())
    const reply = await call<SshConnectResponse>('POST', `${BASE}/machines/connect`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ tunnelBaseUrl: 'http://127.0.0.1:45678' })
  })

  it('saves a machine with write-only secrets', async () => {
    const save = vi.fn(async () => {})
    installHost(fakeHost({ save }))
    const reply = await call<SshActionResponse>('POST', `${BASE}/machines`, {
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
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({})
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

  it('rejects malformed machine writes', async () => {
    const save = vi.fn(async () => {})
    installHost(fakeHost({ save }))
    const missingRow = await call<SshActionResponse>('POST', `${BASE}/machines`, { machineId: 'm1' })
    expect(missingRow.status).toBe(400)
    expect(missingRow.body).toEqual({ error: 'missing row' })
    const badName = await call<SshActionResponse>('POST', `${BASE}/machines`, { machineId: 'm1', row: { name: '', host: 'x', user: 'u' } })
    expect(badName.body).toEqual({ error: 'invalid row: name' })
    const badHost = await call<SshActionResponse>('POST', `${BASE}/machines`, { machineId: 'm1', row: { name: 'a', host: '', user: 'u' } })
    expect(badHost.body).toEqual({ error: 'invalid row: host' })
    const badUser = await call<SshActionResponse>('POST', `${BASE}/machines`, { machineId: 'm1', row: { name: 'a', host: 'x', user: 7 } })
    expect(badUser.body).toEqual({ error: 'invalid row: user' })
    const badSecrets = await call<SshActionResponse>('POST', `${BASE}/machines`, { machineId: 'm1', row: { name: 'a', host: 'x', user: 'u' }, secrets: 'nope' })
    expect(badSecrets.body).toEqual({ error: 'invalid secrets' })
    const noMachine = await call<SshActionResponse>('POST', `${BASE}/machines`, { row: { name: 'a', host: 'x', user: 'u' } })
    expect(noMachine.body).toEqual({ error: 'missing machineId' })
    expect(save).not.toHaveBeenCalled()
  })

  it('applies row defaults for absent numeric fields and drops empty optionals', async () => {
    const save = vi.fn(async () => {})
    installHost(fakeHost({ save }))
    await call('POST', `${BASE}/machines`, {
      machineId: 'm1',
      row: { name: 'a', host: 'x', user: 'u', startCommand: '', profileName: ' keep-me ', color: '', tintBorder: false },
    })
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080, profileName: 'keep-me' },
      undefined,
    )
  })

  it('drops absent secret fields', async () => {
    const save = vi.fn(async () => {})
    installHost(fakeHost({ save }))
    await call('POST', `${BASE}/machines`, {
      machineId: 'm1',
      row: { name: 'a', host: 'x', user: 'u' },
      secrets: { passphrase: 'PHRASE' },
    })
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { passphrase: 'PHRASE' },
    )
    await call('POST', `${BASE}/machines`, {
      machineId: 'm1',
      row: { name: 'a', host: 'x', user: 'u' },
      secrets: { password: 'P' },
    })
    expect(save).toHaveBeenLastCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { password: 'P' },
    )
  })

  it('removes a machine', async () => {
    const remove = vi.fn(async () => {})
    installHost(fakeHost({ remove }))
    const reply = await call<SshActionResponse>('DELETE', `${BASE}/machines`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({})
    expect(remove).toHaveBeenCalledWith(MachineId('m1'))
  })

  it('requires a machineId on removal', async () => {
    const remove = vi.fn(async () => {})
    installHost(fakeHost({ remove }))
    const reply = await call<SshActionResponse>('DELETE', `${BASE}/machines`, {})
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({ error: 'missing machineId' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('disconnects a machine', async () => {
    const disconnect = vi.fn(async () => {})
    installHost(fakeHost({ disconnect }))
    const reply = await call<SshActionResponse>('POST', `${BASE}/machines/disconnect`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({})
    expect(disconnect).toHaveBeenCalledWith(MachineId('m1'))
  })

  it('installs dsh on a machine and returns the outcome', async () => {
    const install = vi.fn(async () => ({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true }))
    installHost(fakeHost({ install }))
    const reply = await call<SshInstallResponse>('POST', `${BASE}/machines/install`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      installed: ['node'],
      dshRef: 'dsh-0.1.2-rc.1-1',
      dshVersion: '0.1.2-rc.1',
      dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      credentialsCopied: true,
    })
    expect(install).toHaveBeenCalledWith(MachineId('m1'), expect.any(AbortSignal))
  })

  it('surfaces machine failures as 400 messages', async () => {
    installHost(fakeHost({
      install: async () => {
        throw new SshError('machine-install-failed', MachineId('m1'), 'pnpm: not found')
      },
    }))
    const install = await call<SshInstallResponse>('POST', `${BASE}/machines/install`, { machineId: 'm1' })
    expect(install.status).toBe(400)
    expect(install.body).toEqual({ error: 'pnpm: not found' })

    installHost(fakeHost({
      test: async () => {
        throw new SshError('machine-connect-failed', MachineId('m1'), 'auth failed')
      },
    }))
    const test = await call<SshTestResponse>('POST', `${BASE}/machines/test`, { machineId: 'm1' })
    expect(test.status).toBe(400)
    expect(test.body).toEqual({ error: 'auth failed' })

    installHost(fakeHost({
      connect: async () => {
        throw new Error('tunnel broken')
      },
    }))
    const connect = await call<SshConnectResponse>('POST', `${BASE}/machines/connect`, { machineId: 'm1' })
    expect(connect.status).toBe(400)
    expect(connect.body).toEqual({ error: 'tunnel broken' })
  })

  it('maps non-Error failures onto their string form', async () => {
    installHost(fakeHost({
      test: async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'boom'
      },
    }))
    const reply = await call<SshTestResponse>('POST', `${BASE}/machines/test`, { machineId: 'm1' })
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({ error: 'boom' })
  })

  it('requires a machineId on actions', async () => {
    installHost(fakeHost())
    const reply = await call<SshTestResponse>('POST', `${BASE}/machines/test`, {})
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({ error: 'missing machineId' })
  })

  it('serves the sync preview', async () => {
    const preview = {
      plugins: [{ name: 'dsh-market', spec: 'github:a/b', syncable: true }],
      skills: [{ name: 'alpha', root: 'dsh' as const }],
    }
    installHost(fakeHost({ syncPreview: () => preview }))
    const reply = await call<SyncPreviewResponse>('GET', `${BASE}/sync/preview`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual(preview)
  })

  it('applies a sync selection and returns per-item results', async () => {
    const syncApply = vi.fn(async () => ({
      items: [
        { kind: 'plugin' as const, name: 'dsh-market', ok: true },
        { kind: 'skill' as const, name: 'alpha', root: 'dsh' as const, ok: false, error: 'exit 1: read-only' },
      ],
    }))
    installHost(fakeHost({ syncApply }))
    const reply = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, {
      machineId: 'm1',
      plugins: [{ name: 'dsh-market', spec: 'github:a/b' }],
      skills: [{ name: 'alpha', root: 'dsh' }],
    })
    expect(reply.status).toBe(200)
    expect(syncApply).toHaveBeenCalledWith(
      MachineId('m1'),
      [{ name: 'dsh-market', spec: 'github:a/b' }],
      [{ name: 'alpha', root: 'dsh' }],
    )
    expect(reply.body.items).toHaveLength(2)
    expect(reply.body.items?.[1]).toMatchObject({ ok: false, error: 'exit 1: read-only' })
  })

  it('defaults an absent sync selection to empty lists', async () => {
    const syncApply = vi.fn(async () => ({ items: [] }))
    installHost(fakeHost({ syncApply }))
    const reply = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, { machineId: 'm1' })
    expect(reply.status).toBe(200)
    expect(syncApply).toHaveBeenCalledWith(MachineId('m1'), [], [])
  })

  it('rejects malformed sync selections', async () => {
    installHost(fakeHost())
    const badPlugin = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, { machineId: 'm1', plugins: [{ name: 'x' }] })
    expect(badPlugin.status).toBe(400)
    expect(badPlugin.body).toEqual({ error: 'invalid plugin ref' })

    const badRoot = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, { machineId: 'm1', skills: [{ name: 'x', root: 'elsewhere' }] })
    expect(badRoot.body).toEqual({ error: 'invalid skill ref: root' })

    const notArray = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, { machineId: 'm1', plugins: 'nope' })
    expect(notArray.body).toEqual({ error: 'invalid plugins' })

    const badSkills = await call<SyncApplyResponse>('POST', `${BASE}/sync/apply`, { machineId: 'm1', skills: 'nope' })
    expect(badSkills.body).toEqual({ error: 'invalid skills' })
  })

  it('drains machine events from the beginning', async () => {
    installHost(fakeHost())
    const reply = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events?machineId=m1`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      items: [
        expect.objectContaining({ seq: 1, stage: 'probe' }),
        expect.objectContaining({ seq: 2, stage: 'download' }),
        expect.objectContaining({ seq: 3, stage: 'ready', terminal: 'success' }),
      ],
      nextSeq: 4,
    })
  })

  it('drains machine events incrementally by sinceSeq', async () => {
    installHost(fakeHost())
    const reply = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events?machineId=m1&sinceSeq=2`)
    expect(reply.body).toMatchObject({ items: [expect.objectContaining({ seq: 3 })], nextSeq: 4 })
  })

  it('reports unknown event machines as an empty page anchored at seq 1', async () => {
    installHost(fakeHost())
    const reply = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events?machineId=ghost`)
    expect(reply.body).toEqual({ items: [], nextSeq: 1 })
  })

  it('rejects malformed event cursors', async () => {
    installHost(fakeHost())
    const negative = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events?machineId=m1&sinceSeq=-1`)
    expect(negative.status).toBe(400)
    expect(negative.body).toEqual({ error: 'invalid sinceSeq' })

    const fractional = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events?machineId=m1&sinceSeq=1.5`)
    expect(fractional.body).toEqual({ error: 'invalid sinceSeq' })

    const missing = await call<SshMachineEventsResponse>('GET', `${BASE}/machines/events`)
    expect(missing.body).toEqual({ error: 'missing machineId' })
  })
})
