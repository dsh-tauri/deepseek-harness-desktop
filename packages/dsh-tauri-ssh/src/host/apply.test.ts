import type { Config as SshRemoteConfig } from './config/schema'
import type { SshHostContext } from './types/index'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from './apply'
import { knownHostsFilePath, machineProfiles, resetRuntime } from './config/runtime'
import { machine } from './service/machine'
import { MachineId } from './types/index'

function scriptedHttpServer() {
  const routes: Array<{ kind: string, path: string, handler?: unknown }> = []
  return {
    routes,
    register: vi.fn((route: { kind: string, path: string, handler?: unknown }) => {
      routes.push(route)
      return () => {}
    }),
  }
}

const REST_ENDPOINTS = [
  '/api/tauri/ssh/settings',
  '/api/tauri/ssh/session/role',
  '/api/tauri/ssh/machines',
  '/api/tauri/ssh/machines/test',
  '/api/tauri/ssh/machines/connect',
  '/api/tauri/ssh/machines/disconnect',
  '/api/tauri/ssh/machines/install',
  '/api/tauri/ssh/machines/events',
  '/api/tauri/ssh/sync/preview',
  '/api/tauri/ssh/sync/apply',
]

/** Plugin config without the optional overrides; defaults are exercised separately. */
const baseConfig: SshRemoteConfig = {
  connectTimeoutMs: 15000,
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 2,
  reconnectMaxAttempts: 2,
}

// Every service construction points the credential/discovery layer and the
// state document at a scratch directory — the developer's real ~/.ssh and
// harness home are never touched.
let sshDir: string
let statePath: string

beforeEach(() => {
  resetRuntime()
  sshDir = mkdtempSync(join(tmpdir(), 'ssh-index-'))
  statePath = join(sshDir, 'machines.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(sshDir, { recursive: true, force: true })
  resetRuntime()
})

/** One scripted context: cordis-shaped surface without real cordis types. */
function scriptedCtx(webServer: unknown): { ctx: SshHostContext, disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    provide: vi.fn(),
    effect: vi.fn((callback: () => (() => void) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function')
        disposers.push(disposer)
    }),
    webServer,
  } as unknown as SshHostContext
  return { ctx, disposers }
}

/** Persist one state document before construction. */
function writeState(state: { enabled?: boolean, machines?: Record<string, unknown> }): void {
  writeFileSync(statePath, `${JSON.stringify({ version: 1, enabled: state.enabled ?? false, machines: state.machines ?? {} }, null, 2)}\n`)
}

/** The stored state document as the service wrote it. */
function readState(): { version: number, enabled: boolean, machines: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(statePath, 'utf8')) as { version: number, enabled: boolean, machines: Record<string, Record<string, unknown>> }
}

/** Assemble the plugin on a scripted webServer double. */
function construct(config: SshRemoteConfig = baseConfig, webServer = scriptedHttpServer()): { ctx: SshHostContext, webServer: ReturnType<typeof scriptedHttpServer>, service: typeof machine, disposers: Array<() => void> } {
  const { ctx, disposers } = scriptedCtx(webServer)
  apply(ctx, { ...config, sshDir, statePath })
  return { ctx, webServer, service: machine, disposers }
}

async function boot(overrides: {
  state?: { enabled?: boolean, machines?: Record<string, unknown> }
  webServer?: ReturnType<typeof scriptedHttpServer>
  config?: Partial<SshRemoteConfig>
} = {}) {
  if (overrides.state !== undefined)
    writeState(overrides.state)
  const webServer = overrides.webServer ?? scriptedHttpServer()
  const { ctx } = scriptedCtx(webServer)
  const config = {
    ...baseConfig,
    knownHostsPath: join(homedir(), '.dsh', 'ssh', 'known-hosts.json'),
    sshDir,
    statePath,
    ...overrides.config,
  }
  apply(ctx, config)
  await machine.start()
  return { ctx, webServer, service: machine }
}

function row(id: string): Record<string, unknown> {
  return {
    id,
    name: `machine-${id}`,
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    password: 'sekrit',
    remotePort: 3080,
  }
}

describe('ssh-remote plugin', () => {
  it('declares its plugin metadata', () => {
    expect(name).toBe('dsh-tauri-ssh')
    expect(inject).toEqual(['webServer', 'connection'])
    expect(apply).toEqual(expect.any(Function))
  })

  it('ships the cordis plugin descriptor as the default export', async () => {
    const descriptor = (await import('./apply')).default
    expect(descriptor).toMatchObject({
      name: 'dsh-tauri-ssh',
      inject: ['webServer', 'connection'],
      Config: expect.anything(),
    })
    expect(descriptor.apply).toEqual(expect.any(Function))
    // The loader reads Config/inject from the default object: a bare function
    // default would lose both (config defaults never apply, services not injected).
    expect(descriptor.apply).toBe(apply)
  })

  it('mounts the REST routes without any settings service', async () => {
    const { webServer } = await boot()
    expect(webServer.routes.map(route => `${route.kind} ${route.path}`)).toEqual(REST_ENDPOINTS.map(path => `exact ${path}`))
    expect(webServer.routes.map(route => typeof route.handler)).toEqual(REST_ENDPOINTS.map(() => 'function'))
  })

  it('starts switched off and persists the enable switch', async () => {
    const { service } = await boot()
    expect(service.enabled()).toBe(false)
    await service.setEnabled(true)
    expect(service.enabled()).toBe(true)
    expect(readState()).toMatchObject({ version: 1, enabled: true })
    await service.setEnabled(false)
    expect(readState()).toMatchObject({ enabled: false })
  })

  it('disconnects every machine when the feature is switched off', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { a: row('a') } } })
    const dispose = vi.spyOn(service, 'dispose').mockResolvedValue(undefined)
    await service.setEnabled(true)
    expect(dispose).not.toHaveBeenCalled()
    await service.setEnabled(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('loads machine profiles from the state document', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { a: row('a') } } })
    const views = service.profileViews()
    expect(views.map(view => view.id)).toEqual(['a'])
    expect(views[0]).toMatchObject({ name: 'machine-a', hasPassword: true })
    expect(views[0]).not.toHaveProperty('password')
  })

  it('reads a corrupt or absent document as the default state', async () => {
    writeFileSync(statePath, '{ not json')
    const corrupt = await boot()
    expect(corrupt.service.enabled()).toBe(false)
    expect(corrupt.service.profileViews()).toEqual([])

    rmSync(statePath, { force: true })
    const absent = await boot()
    expect(absent.service.enabled()).toBe(false)
    expect(absent.service.profileViews()).toEqual([])
  })

  it('drops a stored row whose dict key disagrees with the profile id', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { b: row('a') } } })
    expect(service.profileViews()).toEqual([])
  })

  it('refreshes the manager when the stored machines change', async () => {
    const { service } = await boot()
    await service.save('a' as never, { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 })
    await service.save('b' as never, { name: 'beta', host: '10.0.0.2', port: 22, user: 'root', remotePort: 3080 })
    expect(service.profileViews()).toHaveLength(2)
    await service.remove('a' as never)
    expect(service.profileViews().map(view => view.id)).toEqual(['b'])
  })

  it('exposes the manager connection plane', async () => {
    const { service } = await boot()
    expect(service.status('ghost' as never)).toEqual({ machineId: 'ghost' as never, state: 'disconnected' })
    expect(service.profileViews()).toEqual([])
    await service.disconnect('a' as never)
  })

  it('forwards installs to the manager', async () => {
    const { service } = await boot()
    const install = vi.spyOn(service, 'install')
      .mockResolvedValue({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true })
    const result = await service.install(MachineId('a'), undefined)
    expect(install).toHaveBeenCalledWith(MachineId('a'), undefined)
    expect(result).toEqual({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true })
  })

  it('saves a machine into the state document and refreshes the manager', async () => {
    const { service } = await boot()
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    }, { password: 'sekrit', passphrase: 'PHRASE' })
    expect(readState().machines.a).toEqual({
      id: 'a',
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
      password: 'sekrit',
      passphrase: 'PHRASE',
    })
    const views = service.profileViews()
    expect(views.map(view => view.id)).toEqual(['a'])
    expect(views[0]).toMatchObject({ name: 'alpha', hasPassword: true })
  })

  it('keeps stored secrets on save unless rewritten', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { a: row('a') } } })
    await service.save('a' as never, {
      name: 'alpha-2',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({ name: 'alpha-2', hasPassword: true })
  })

  it('clears optional appearance fields on save and keeps sibling machines intact', async () => {
    const { service } = await boot({
      state: {
        enabled: true,
        machines: {
          a: { ...row('a'), color: '#ff0000', tintBorder: true, startCommand: 'custom dsh web' },
          b: row('b'),
        },
      },
    })
    await service.save('a' as never, {
      name: 'alpha-3',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    })
    const viewA = service.profileViews().find(view => view.id === 'a')
    // 清除方向：color/tintBorder/startCommand 的空/关形态（row 缺位）必须真
    // 清除——save 写的是整份 profile，缺位字段不会从旧值复活（回归守护）。
    expect(viewA).not.toHaveProperty('color')
    expect(viewA).not.toHaveProperty('tintBorder')
    expect(viewA).not.toHaveProperty('startCommand')
    // 同表其他机器原样保留
    expect(service.profileViews().find(view => view.id === 'b')).toMatchObject({ name: 'machine-b', hasPassword: true })
  })

  it('keeps stored secrets on save and stores the start command', async () => {
    const { service } = await boot({
      state: { enabled: true, machines: { a: { ...row('a'), passphrase: 'OLD-PHRASE' } } },
    })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
      startCommand: 'dsh web --port 3080',
    }, { passphrase: 'NEW-PHRASE' })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({
      name: 'alpha',
      hasPassword: true,
      hasPassphrase: true,
      startCommand: 'dsh web --port 3080',
    })
  })

  it('stores the remote profile name on save and clears it when the row omits it', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { a: { ...row('a'), profileName: 'alpha' } } } })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
      profileName: 'beta',
    })
    // 回归守护：save 必须搬运 row.profileName，否则每次编辑都会把远端 profile
    // 名清掉、静默退回默认 `remote` profile。
    expect(service.profileViews()[0]).toMatchObject({ profileName: 'beta' })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    })
    expect(service.profileViews()[0]).not.toHaveProperty('profileName')
  })

  it('keeps whichever stored secrets exist and rewrites only typed ones', async () => {
    const { service } = await boot({
      state: { enabled: true, machines: { a: { ...row('a'), password: undefined, passphrase: 'OLD-PHRASE' } } },
    })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    }, { password: 'NEW-PW' })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({ name: 'alpha', hasPassword: true, hasPassphrase: true })
    const stored = readState().machines.a
    expect(stored?.password).toBe('NEW-PW')
    expect(stored?.passphrase).toBe('OLD-PHRASE')
  })

  it('discovers ~/.ssh/config aliases as read-only machines', async () => {
    writeFileSync(join(sshDir, 'config'), [
      'Host dev',
      '  HostName 10.0.0.9',
      '  User root',
      '  Port 2222',
      'Host ci',
      '  IdentityFile ~/.ssh/special',
      'Host *.example.com',
      'Host !banned',
    ].join('\n'))
    const { service } = await boot()
    const views = await service.discoveredViews()
    expect(views.map(view => view.id)).toEqual(['ci', 'dev'])
    expect(views[1]).toMatchObject({
      id: 'dev',
      name: 'dev',
      host: 'dev',
      port: 2222,
      user: 'root',
      hasPassword: false,
      hasPassphrase: false,
      remotePort: 3080,
    })
    expect(service.profileViews()).toEqual([])
  })

  it('lists no discovered machines without a config file', async () => {
    const { service } = await boot()
    expect(await service.discoveredViews()).toEqual([])
  })

  it('lets a manual machine shadow a config alias', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n')
    const { service } = await boot({ state: { enabled: true, machines: { dev: { ...row('dev'), host: '10.1.1.1' } } } })
    expect((await service.discoveredViews()).map(view => view.id)).toEqual([])
    expect(service.profileViews().map(view => view.id)).toEqual(['dev'])
  })

  it('syncs discovered aliases into the manager profile map', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n  Port 2222\n')
    await boot()
    await machine.syncProfiles()
    const merged = machineProfiles.get(MachineId('dev'))
    expect([...machineProfiles.keys()]).toEqual([MachineId('dev')])
    expect(merged).toMatchObject({ host: 'dev', port: 2222, user: 'root' })
  })

  it('applies the configured remote port and start command template to discovered aliases', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n')
    const { service } = await boot({ config: { remotePort: 3199, startCommand: '$HOME/.local/bin/dsh web --host 127.0.0.1 --port {port}' } })
    const views = await service.discoveredViews()
    expect(views[0]).toMatchObject({ id: 'dev', remotePort: 3199, startCommand: '$HOME/.local/bin/dsh web --host 127.0.0.1 --port 3199' })
  })

  it('applies the configured default start command to manual machines without their own', async () => {
    await boot({ state: { enabled: true, machines: { a: row('a') } }, config: { remotePort: 3080, startCommand: 'dsh web --port {port}' } })
    await machine.syncProfiles()
    expect(machineProfiles.get(MachineId('a'))).toMatchObject({ id: 'a', startCommand: 'dsh web --port 3080' })
  })

  it('keeps a manual start command over the configured default', async () => {
    await boot({
      state: { enabled: true, machines: { a: { ...row('a'), startCommand: 'custom dsh web' } } },
      config: { remotePort: 3080, startCommand: 'dsh web --port {port}' },
    })
    await machine.syncProfiles()
    expect(machineProfiles.get(MachineId('a'))).toMatchObject({ id: 'a', startCommand: 'custom dsh web' })
  })

  it('removes a machine from the state document', async () => {
    const { service } = await boot({ state: { enabled: true, machines: { a: row('a'), b: row('b') } } })
    await service.remove('a' as never)
    expect(service.profileViews().map(view => view.id)).toEqual(['b'])
    expect(readState().machines).not.toHaveProperty('a')
  })

  it('delegates test and connect to the manager', async () => {
    const { service } = await boot()
    await expect(service.test('ghost' as never)).rejects.toMatchObject({ code: 'machine-not-found' })
    await expect(service.connect('ghost' as never)).rejects.toMatchObject({ code: 'machine-not-found' })
  })

  it('defaults the state document and known-hosts path under DSH_HOME', async () => {
    const previous = process.env.DSH_HOME
    const home = join(sshDir, 'dsh-home')
    try {
      process.env.DSH_HOME = home
      apply(scriptedCtx(scriptedHttpServer()).ctx, { ...baseConfig, sshDir })
      await machine.start()
      expect(knownHostsFilePath()).toBe(join(home, 'ssh', 'known-hosts.json'))
      await machine.setEnabled(true)
      expect(JSON.parse(readFileSync(join(home, 'ssh', 'machines.json'), 'utf8'))).toMatchObject({ version: 1, enabled: true })
    }
    finally {
      if (previous === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = previous
    }
  })

  it('disposes the manager when the context tears down', () => {
    const { service, disposers } = construct()
    const dispose = vi.spyOn(service, 'dispose').mockResolvedValue(undefined)
    expect(disposers).toHaveLength(2)
    for (const disposeAll of disposers) disposeAll()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('assembles the plugin declaratively', () => {
    const { ctx, webServer } = construct()
    expect(webServer.routes.map(route => `${route.kind} ${route.path}`)).toEqual(REST_ENDPOINTS.map(path => `exact ${path}`))
    expect(apply(ctx, { ...baseConfig, sshDir, statePath })).toBeUndefined()
  })
})
