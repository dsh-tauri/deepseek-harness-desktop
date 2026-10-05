import type { AddressInfo, Server } from 'node:net'
import type { MachineProfile, RemoteExecOptions, RemoteExecResult, RemoteMachineEvent, RemoteSession, RemoteStreamHandle } from '../types/index'
import type { RemoteTransport, RemoteTransportCapabilities, RemoteTransportOptions } from './transport.types'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get, request } from 'node:http'
import { Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHostRuntime, machineStates, machineTable, setHostConfig, setKnownHostsPath, setMachineDeps } from '../config/runtime'
import { MachineId, RemoteError } from '../types/index'
import { EMPTY_ALLOWLIST } from '../utils/allowlist'
import { events } from './events'
import { gateway } from './gateway'
import { machine } from './machine'

const profile: MachineProfile = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  password: 'sekrit',
  remotePort: 3080,
}

const secondProfile: MachineProfile = {
  ...profile,
  id: MachineId('m2'),
  name: 'beta',
  profileName: 'work',
}

const config = {
  connectTimeoutMs: 15000,
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
  installRef: 'dsh-0.1.2-rc.1-33729514615',
  installTimeoutMs: 60000,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 2,
  reconnectMaxAttempts: 2,
}

function githubJson(body: unknown): { ok: boolean, status: number, json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

function stubGithub(): void {
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/releases?per_page='))
      return Promise.resolve(githubJson([{ tag_name: config.installRef, draft: false, prerelease: true }]))
    if (url.includes('/releases/tags/'))
      return Promise.resolve(githubJson({ assets: [{ name: 'deepseek-harness-pkg-linux.zip', browser_download_url: 'https://example.test/deepseek-harness-pkg-linux.zip', digest: 'sha256:0000' }] }))
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
}

/** A boot page whose manifest the bundle probe confirms. */
const BOOT_HTML = '<html><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>'

/** The layout entry the pinned dsh release resolves: the remote shell expands $HOME (root user in the fake). */
const ENTRY = '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

class FakeSession implements RemoteSession {
  commands: string[] = []
  options: RemoteExecOptions[] = []
  closed = false
  tunnel: RemoteStreamHandle | undefined
  closeCalls = 0
  tunnelCloseCalls = 0
  closeError: Error | undefined
  tunnelCloseError: Error | undefined
  tunnelGate: Promise<void> | undefined
  tunnelStarted: (() => void) | undefined
  execGate: ((command: string, index: number) => Promise<void> | undefined) | undefined
  /** The preferred local port the last stream call received. */
  preferredTunnelPort: number | undefined
  authMethod: RemoteSession['authMethod'] = 'key'
  private closedCallbacks: Array<() => void> = []

  constructor(
    public healthHealthy: (probeIndex: number) => boolean,
    public connectError?: Error,
    public startError?: Error,
    public installError?: Error,
  ) {}

  /** The uname answer the platform probe prints (default: linux x64). */
  unameResult = 'Linux 6.8.0-45-generic x86_64\n'
  /** The check-script answer: one missing component per line (default: none). */
  missingResult = ''
  /** When set, the plugin-sync apply command answers a non-zero code with this stderr. */
  pluginSyncError: Error | undefined
  /** The local port the fake tunnel reports. */
  tunnelPort = 49152
  /** Whether the launch answered REMOTE_NOT_INSTALLED instead of starting. */
  startNotInstalled = false
  /** The web-log token grep answer (default: no token → bare tunnel URL). */
  webTokenResult = ''

  exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    this.commands.push(command)
    this.options.push(options ?? {})
    const respond = (): RemoteExecResult => {
      if (this.connectError !== undefined)
        throw this.connectError
      if (command === 'uname -srm') {
        return { code: 0, stdout: this.unameResult, stderr: '' }
      }
      if (command.includes('echo node')) {
        return { code: 0, stdout: this.missingResult, stderr: '' }
      }
      if (command.includes('trap cleanup EXIT')) {
        // A successful script settles the missing set, like a real install.
        this.missingResult = this.installError !== undefined ? this.missingResult : ''
        if (this.installError !== undefined)
          return { code: 1, stdout: '::dsh install far', stderr: this.installError.message }
        return { code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' }
      }
      if (command.includes('.dsh-desktop/plugins')) {
        if (this.pluginSyncError !== undefined)
          return { code: 1, stdout: '', stderr: this.pluginSyncError.message }
        return command.includes('PLUGINS_SYNCED')
          ? { code: 0, stdout: 'PLUGINS_SYNCED\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' }
      }
      if (command.includes('test -f ')) {
        // The real command prints the $HOME-expanded absolute entry path.
        return { code: 0, stdout: `${ENTRY}\n`, stderr: '' }
      }
      if (command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')) {
        return { code: 0, stdout: this.credentialsAnswer, stderr: '' }
      }
      // 注意用命令头识别：launch 命令行里也含日志路径（重定向目标）
      if (command.startsWith('grep -oE \'token=')) {
        return { code: 0, stdout: this.webTokenResult, stderr: '' }
      }
      if (command.includes('dsh-remote.pid')) {
        if (this.startNotInstalled)
          return { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' }
        if (this.startError !== undefined)
          return { code: 127, stdout: '', stderr: this.startError.message }
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      // 探测序号而非命令序号：连接流程里插入与探测无关的命令（pnpm 垫片）不该
      // 移动「第几次探测」的语义，否则守卫用例会被无关改动带崩。计数只在探测
      // 分支里推进——落到兜底返回的命令不是探测。
      if (command.includes('/dev/null')) {
        return this.healthHealthy(this.probesAnswered++)
          ? { code: 0, stdout: '200', stderr: '' }
          : { code: 7, stdout: '', stderr: 'refused' }
      }
      if (command.includes('curl')) {
        const healthy = this.healthHealthy(this.probesAnswered++)
        if (!healthy)
          return { code: 7, stdout: '', stderr: 'refused' }
        // The bundle probe (status-suffixed) answers JavaScript; the root
        // probe answers the boot page.
        return command.includes('-w')
          ? { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
          : { code: 0, stdout: BOOT_HTML, stderr: '' }
      }
      return { code: 0, stdout: '200', stderr: '' }
    }
    const gate = this.execGate?.(command, this.commands.length - 1)
    if (gate === undefined)
      return Promise.resolve(respond())
    return gate.then(respond)
  }

  /** Probes answered so far (the health predicate's argument). */
  private probesAnswered = 0

  /** The stdout the credentials-copy command answers (default: copied). */
  credentialsAnswer = 'copied'

  async stream(_remotePort: number, preferredLocalPort?: number): Promise<RemoteStreamHandle> {
    this.preferredTunnelPort = preferredLocalPort
    this.tunnelStarted?.()
    if (this.tunnelGate !== undefined)
      await this.tunnelGate
    this.tunnel = {
      localPort: this.tunnelPort,
      close: async () => {
        this.tunnelCloseCalls += 1
        this.tunnel = undefined
        if (this.tunnelCloseError !== undefined)
          throw this.tunnelCloseError
      },
    }
    return this.tunnel
  }

  onClosed(callback: () => void): void {
    this.closedCallbacks.push(callback)
  }

  drop(): void {
    for (const callback of this.closedCallbacks.splice(0)) callback()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.closed = true
    if (this.closeError !== undefined)
      throw this.closeError
  }
}

class FakeTransport implements RemoteTransport {
  sessions: FakeSession[] = []
  connectCalls = 0
  hostKeys: Array<{ key: Buffer, accepted: boolean }> = []
  rejectKeys = false
  /** The profile each connect call received (the loop must re-read edits). */
  profiles: MachineProfile[] = []
  capabilities: RemoteTransportCapabilities = { exec: true, stream: true }

  constructor(private readonly sessionFactory: () => FakeSession) {}

  async connect(
    profile: MachineProfile,
    hostKeyVerifier: (label: string, key: Buffer) => boolean | Promise<boolean>,
    _options: RemoteTransportOptions,
    _signal?: AbortSignal,
  ): Promise<RemoteSession> {
    this.connectCalls += 1
    this.profiles.push(profile)
    const session = this.sessionFactory()
    this.sessions.push(session)
    if (this.rejectKeys)
      throw new Error('auth failed')
    if (session.connectError !== undefined)
      throw session.connectError
    const key = Buffer.from('host-key')
    this.hostKeys.push({ key, accepted: await hostKeyVerifier(String(profile.id), key) })
    return session
  }
}

const roots: string[] = []

const harnessHomeBefore = process.env.DSH_HOME

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-manager-'))
  roots.push(root)
  return root
}

function harnessHomeWith(credentials: { apiKey?: string, baseUrl?: string }): string {
  const root = tempRoot()
  const lines = [
    ...credentials.apiKey === undefined ? [] : [`DEEPSEEK_API_KEY=${credentials.apiKey}`],
    ...credentials.baseUrl === undefined ? [] : [`DEEPSEEK_BASE_URL=${credentials.baseUrl}`],
  ]
  writeFileSync(join(root, '.env'), lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  return root
}

function quiet(): boolean {
  return [...machineStates.values()].every(state => state.connecting === undefined && state.installing === undefined && state.reconnect === undefined)
}

async function settleRuntime(): Promise<void> {
  let seen = -1
  let calm = 0
  for (let attempt = 0; attempt < 1000 && calm < 4; attempt += 1) {
    const terminals = terminalsOf(events).length
    calm = quiet() && terminals === seen ? calm + 1 : 0
    seen = terminals
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(calm, 'SSH runtime did not finish its background operations').toBe(4)
}

beforeEach(() => {
  stubGithub()
})

afterEach(async () => {
  try {
    await settleRuntime()
  }
  finally {
    try {
      await machine.dispose()
      await gateway.dispose()
      await settleRuntime()
    }
    finally {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
      if (harnessHomeBefore === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = harnessHomeBefore
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      clearHostRuntime()
    }
  }
})

/** The connect-time prelude markers (plugin sync, pnpm shim, build-allowlist carry). */
const PRELUDE_MARKERS = ['.dsh-desktop/plugins', 'chmod +x "$B/pnpm"', 'pnpm-workspace.yaml']

function bootstrapFlowCommands(session: FakeSession): string[] {
  return session.commands.filter(command => !PRELUDE_MARKERS.some(marker => command.includes(marker)))
}

/** Wait until the predicate holds (background reconnect races). */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Wait until one machine settles into its terminal state after a failure. */
async function untilSettled(manager: typeof machine, machineId: MachineId = MachineId('m1')): Promise<void> {
  await until(() => {
    const state = manager.status(machineId).state
    return state === 'given-up' || state === 'connected' || state === 'disconnected'
  }, 'terminal state')
}

function boot(overrides: Partial<{
  sessionFactory: () => FakeSession
  rejectKeys: boolean
  envCredentials: () => { apiKey?: string, baseUrl?: string }
  config: typeof config
  localAllowlist: () => import('../utils/allowlist').WorkspaceAllowlist
  capabilities: Partial<RemoteTransportCapabilities>
}> = {}) {
  const transport = new FakeTransport(overrides.sessionFactory ?? (() => new FakeSession(() => true)))
  transport.rejectKeys = overrides.rejectKeys ?? false
  transport.capabilities = { ...transport.capabilities, ...overrides.capabilities }
  const emits: Array<{ id: MachineId, state: string, progress?: { phase: string } }> = []
  clearHostRuntime()
  if (overrides.envCredentials !== undefined)
    process.env.DSH_HOME = harnessHomeWith(overrides.envCredentials())
  setHostConfig({ ...(overrides.config ?? config), sshDir: tempRoot() })
  setKnownHostsPath(join(tempRoot(), 'known-hosts.json'))
  const bundledPluginsRoot = tempRoot()
  mkdirSync(join(bundledPluginsRoot, 'dsh-tauri-remote'))
  writeFileSync(join(bundledPluginsRoot, 'dsh-tauri-remote', 'package.json'), JSON.stringify({ name: 'dsh-tauri-remote', dsh: { bundle: {} } }))
  setMachineDeps({
    transport: { resolve: () => transport },
    bundledPluginsTree: { root: bundledPluginsRoot, pluginNames: ['dsh-tauri-remote'] },
    localAllowlist: overrides.localAllowlist ?? (() => EMPTY_ALLOWLIST),
    emitStatus: (id, status) => {
      emits.push({ id, state: status.state, ...status.progress === undefined ? {} : { progress: status.progress } })
    },
  })
  machineTable.machines.set(profile.id, profile)
  machineTable.machines.set(secondProfile.id, secondProfile)
  machine.refreshProfiles(new Map(machineTable.machines))
  return { manager: machine, transport, emits, events }
}

/** The terminal (settling) events one machine's channel recorded. */
function terminalsOf(log: typeof events): RemoteMachineEvent[] {
  return log.since(MachineId('m1')).events.filter(event => event.terminal !== undefined)
}

/** 网关候选端口数：首选端口 + 20 次回落（S2 的端口回落语义，测试侧独立固定）。 */
const GATEWAY_CANDIDATES = 21

interface StandInRecord {
  url: string
  host: string | undefined
  encoding: string | undefined
  cookie: string | undefined
}

interface RemoteStandIn {
  port: number
  records: StandInRecord[]
  /** 远端实例当前认可的会话 cookie；重启后换新值，旧 cookie 随即 401。 */
  sessionCookie: (value: string) => void
  close: () => Promise<void>
}

/**
 * 远端 DSH 的替身：`/?token=<t>` 铸造 `dsh-session=<t>`，其余请求只在带上当前有效
 * cookie 时回 200，否则 401。每条请求的 Host / Accept-Encoding / Cookie 都被记录，
 * 供出站腿的改写与注入断言使用。
 */
async function remoteStandIn(port = 0): Promise<RemoteStandIn> {
  const records: StandInRecord[] = []
  let accepted = 'dsh-session=tok-abc-123'
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    records.push({
      url,
      host: request.headers.host,
      encoding: request.headers['accept-encoding'],
      cookie: request.headers.cookie,
    })
    const token = new URLSearchParams(url.slice(url.indexOf('?'))).get('token')
    if (url.startsWith('/?token=') && token !== null) {
      response.setHeader('set-cookie', [`dsh-session=${token}; Path=/; HttpOnly`])
      response.end('minted')
      return
    }
    if (request.headers.cookie !== accepted) {
      response.statusCode = 401
      response.end('unauthorized')
      return
    }
    response.end('dsh-ok')
  })
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    records,
    sessionCookie: (value: string) => {
      accepted = value
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

/** stand-in 的会话替身：隧道口指向 stand-in，启动 token 取用远端日志里的那一枚。 */
function standInSession(standIn: RemoteStandIn): FakeSession {
  const session = new FakeSession(() => true)
  session.webTokenResult = 'tok-abc-123\n'
  session.tunnelPort = standIn.port
  return session
}

function getThrough(url: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
  })
}

function listenAt(port: number): Promise<Server> {
  const server = new NetServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * 隧道口与远端实例之间的第二跳：`instanceAlive()` 取假时照真实观感把该条连接掐断（没有状态行），
 * 于是隧道口仍在而实例已死——这正是「逐请求失败」与「链路丢失」的区别所在。隧道口本身的死活
 * 由调用方直接关掉本服务器表达。
 */
function hopThrough(target: number, instanceAlive: () => boolean): Promise<{ port: number, close: () => Promise<void> }> {
  const server = createServer((incoming, outgoing) => {
    if (!instanceAlive()) {
      outgoing.destroy()
      incoming.resume()
      return
    }
    const forwarded = request({ host: '127.0.0.1', port: target, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, connection: 'close' } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    forwarded.on('error', () => outgoing.destroy())
    incoming.pipe(forwarded)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as AddressInfo).port,
      close: async () => {
        await new Promise<void>((done) => {
          server.close(() => done())
        })
      },
    }))
  })
}

async function closeServers(servers: Server[]): Promise<void> {
  for (const server of servers)
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
}

/** 连续 count 个空闲回环端口的占用者：`preferred` 起优先，不成则扫描一段静态范围，绝不静默降级为更弱的用例。 */
async function occupyRange(count: number, preferred: number): Promise<{ base: number, servers: Server[] }> {
  const bases = [preferred]
  for (let base = 20_000; base < 60_000; base += count + 1)
    bases.push(base)
  for (const base of bases) {
    const servers: Server[] = []
    try {
      for (let offset = 0; offset < count; offset += 1)
        servers.push(await listenAt(base + offset))
      return { base, servers }
    }
    catch {
      await closeServers(servers)
    }
  }
  throw new Error(`找不到连续 ${count} 个空闲回环端口`)
}

describe('sshManager', () => {
  it('lists redacted profile views in settings order', () => {
    const { manager } = boot()
    const views = manager.profileViews()
    expect(views.map(view => view.id)).toEqual([MachineId('m1'), MachineId('m2')])
    expect(views[0]).toMatchObject({
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      hasPassword: true,
      hasPassphrase: false,
      remotePort: 3080,
    })
    expect(manager.statuses().map(status => status.machineId)).toEqual([MachineId('m1'), MachineId('m2')])
    expect(manager.statuses()[0]).toEqual({ machineId: MachineId('m1'), state: 'disconnected' })
  })

  it('reports unknown machines as disconnected without state', () => {
    const { manager } = boot()
    expect(manager.status(MachineId('ghost'))).toEqual({ machineId: MachineId('ghost'), state: 'disconnected' })
    expect(manager.link(MachineId('ghost'))).toBeUndefined()
  })

  it('connects a healthy machine and publishes the gateway link', async () => {
    const { manager, transport, emits } = boot()
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toBe(manager.status(MachineId('m1')).tunnelBaseUrl)
    expect(link.tunnelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(link.tunnelBaseUrl).not.toContain('token')
    expect(manager.link(MachineId('m1'))).toEqual(link)
    expect(manager.status(MachineId('m1')).state).toBe('connected')
    expect(transport.connectCalls).toBe(1)
    expect(transport.hostKeys[0]?.accepted).toBe(true)
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'connected'])
  })

  it('is idempotent for an already-connected machine', async () => {
    const { manager, transport } = boot()
    const first = await manager.connect(MachineId('m1'))
    const second = await manager.connect(MachineId('m1'))
    expect(second).toBe(first)
    expect(transport.connectCalls).toBe(1)
  })

  it('dedupes concurrent connects onto one attempt', async () => {
    const { manager, transport } = boot()
    const [a, b] = await Promise.all([manager.connect(MachineId('m1')), manager.connect(MachineId('m1'))])
    expect(a).toBe(b)
    expect(transport.connectCalls).toBe(1)
  })

  it('auto-starts the instance when the first probe fails', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager } = boot({ sessionFactory: () => session })
    await manager.connect(MachineId('m1'))
    const flow = bootstrapFlowCommands(session)
    expect(flow[0]).toContain('curl')
    expect(flow[1]).toBe('uname -srm')
    expect(flow[2]).toContain('echo node')
    expect(flow[3]).toContain('dsh-remote.pid')
    expect(flow[3]).toContain('--host 127.0.0.1')
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('reports the profile a machine serves, defaulting when unset', () => {
    const { manager } = boot()
    // boot()'s m1 has no profileName; the second profile pins one.
    expect(manager.profileName(MachineId('m1'))).toBe('remote')
    expect(manager.profileName(MachineId('m2'))).toBe('work')
    expect(manager.profileName(MachineId('unknown'))).toBe('remote')
  })

  it('writes the remote pnpm shim on connect and reports it on the event channel', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager, events } = boot({ sessionFactory: () => session })
    await manager.connect(MachineId('m1'))
    const ensure = session.commands.find(command => command.includes('dependencies/pnpm/bin/pnpm.cjs'))
    expect(ensure).toBeDefined()
    expect(ensure).toContain('chmod +x')
    const lines = events.since(MachineId('m1')).events.map(event => event.line)
    expect(lines.some(line => line.includes('pnpm 垫片就绪'))).toBe(true)
  })

  it('carries the local build allowlist into the remote profile on connect', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager, events } = boot({
      sessionFactory: () => session,
      localAllowlist: () => ({ allowBuilds: { 'node-pty': true }, onlyBuiltDependencies: [] }),
    })
    await manager.connect(MachineId('m1'))
    const write = session.commands.find(command => command.includes('> "$HOME/.dsh/profiles/remote/pnpm-workspace.yaml"'))
    expect(write).toBeDefined()
    expect(write).toContain('node-pty')
    expect(events.since(MachineId('m1')).events.map(event => event.line).some(line => line.includes('构建放行白名单已补齐 1 项'))).toBe(true)
  })

  it('leaves the remote workspace alone when the local allowlist is empty', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager } = boot({ sessionFactory: () => session })
    await manager.connect(MachineId('m1'))
    expect(session.commands.some(command => command.includes('pnpm-workspace.yaml'))).toBe(false)
  })

  it('publishes and clears externally driven progress (the sync engine)', () => {
    const { manager, emits } = boot()
    manager.setProgress(MachineId('m1'), { phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-remote' })
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-remote' })
    manager.setProgress(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    expect(emits.map(entry => entry.progress)).toEqual([
      { phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-remote' },
      undefined,
    ])
  })

  it('publishes live progress phases while connecting', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'handshake' })
    await pending
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    const phases = emits.filter(entry => entry.progress !== undefined).map(entry => entry.progress)
    expect(phases).toEqual([
      { phase: 'handshake' },
      { phase: 'starting' },
      { phase: 'probing', attempt: 1, total: 3 },
    ])
  })

  it('does not publish bootstrap progress once a disconnect superseded the attempt', async () => {
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const session = new FakeSession(index => index !== 0)
    session.execGate = command => command.includes('--no-open') ? startGate : undefined
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    // Wait until the start command is in flight, then supersede the attempt.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('--no-open'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    releaseStart!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed' })
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    // 'starting' fires before the start command (legitimately pre-disconnect);
    // the post-disconnect 'probing' phases must never be published.
    expect(emits.filter(entry => entry.progress?.phase === 'probing')).toEqual([])
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'connecting', 'disconnected'])
  })

  it('clears progress and reports the failure when connect fails', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    await untilSettled(manager)
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('given-up')
    expect(status.progress).toBeUndefined()
    expect(status.lastError).toBe('connect failed after 3 attempt(s): auth failed')
    expect(status.nextRetryAt).toBeUndefined()
  })

  it('fails loud with machine-connect-failed on transport errors', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow(RemoteError)
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-reconnecting' })
    await untilSettled(manager)
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('given-up')
    expect(status.lastError).toBe('connect failed after 3 attempt(s): auth failed')
  })

  it('fails loud with machine-bootstrap-failed when the instance never answers', async () => {
    const { manager } = boot({ sessionFactory: () => new FakeSession(() => false) })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
  })

  it('fails loud with machine-bootstrap-failed when the start command fails', async () => {
    const { manager } = boot({
      sessionFactory: () => new FakeSession(() => false, undefined, new Error('dsh: not found')),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
  })

  it('settles the bootstrap stream when a transport exception bypasses the bootstrap failure path', async () => {
    const session = new FakeSession(() => false)
    session.exec = () => Promise.reject(new Error('channel reset during probe'))
    const { manager, events } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed', line: 'bootstrap 失败' })
    expect(terminals[0]?.reason).toContain('channel reset')
  })

  it('never double-settles a bootstrap failure the bootstrap itself already recorded', async () => {
    const { manager, events } = boot({ sessionFactory: () => new FakeSession(() => false) })
    // The never-ready path settles through its own terminal event; the
    // manager's catch must not append a second one.
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.reason).toContain('did not become ready')
  })

  it('rejects unknown machine ids with machine-not-found', async () => {
    const { manager, transport } = boot()
    await expect(manager.connect(MachineId('ghost'))).rejects.toMatchObject({ code: 'machine-not-found' })
    await expect(manager.test(MachineId('ghost'))).rejects.toMatchObject({ code: 'machine-not-found' })
    expect(transport.connectCalls).toBe(0)
  })

  it('resolves idempotently for unknown machine ids on disconnect', async () => {
    const { manager } = boot()
    await manager.disconnect(MachineId('ghost'))
    expect(manager.status(MachineId('ghost')).state).toBe('disconnected')
  })

  it('disconnects a connected machine idempotently', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    await manager.disconnect(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.link(MachineId('m1'))).toBeUndefined()
    expect(session.closeCalls).toBe(1)
    expect(session.tunnelCloseCalls).toBe(1)
  })

  it('swallows teardown failures on disconnect', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.tunnelCloseError = new Error('listener busy')
    session.closeError = new Error('socket busy')
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('cancels an in-flight connect on disconnect', async () => {
    const { manager, emits } = boot({ rejectKeys: true })
    const pending = manager.connect(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'disconnected'])
  })

  it('cancels an in-flight connect that disconnects during bootstrap', async () => {
    let releaseProbe: (() => void) | undefined
    let markProbeStarted: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.exec = () => {
      markProbeStarted?.()
      return gate.then(() => ({ code: 0, stdout: '200', stderr: '' }))
    }
    const { manager, events } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await probeStarted
    await manager.disconnect(MachineId('m1'))
    releaseProbe!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    // The bootstrap itself had settled ready (its own success terminal);
    // the cancelled connect adds no failure terminal afterwards.
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'ready', terminal: 'success' })
  })

  it('cancels an in-flight connect that disconnects during tunnel opening', async () => {
    let releaseTunnel: (() => void) | undefined
    let markTunnelStarted: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseTunnel = resolve
    })
    const tunnelStarted = new Promise<void>((resolve) => {
      markTunnelStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.tunnelGate = gate
    session.tunnelStarted = () => markTunnelStarted?.()
    session.tunnelCloseError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await tunnelStarted
    await manager.disconnect(MachineId('m1'))
    releaseTunnel!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('cancels an in-flight connect that disconnects while the gateway entry is starting', async () => {
    let releaseStart: (() => void) | undefined
    let markStartEntered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve
    })
    const original = gateway.start
    vi.spyOn(gateway, 'start').mockImplementation(async (options) => {
      markStartEntered?.()
      await gate
      return await original(options)
    })
    const { manager, transport } = boot()
    const pending = manager.connect(MachineId('m1'))
    await startEntered
    await manager.disconnect(MachineId('m1'))
    releaseStart!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.link(MachineId('m1'))).toBeUndefined()
    // 断开必须真的赢：成功路径不得把状态改写回 connected，也不得留下监听口或会话
    expect(gateway.list()).toEqual([expect.objectContaining({ id: 'remote-outbound:m1', state: 'stopped', port: 0 })])
    expect(transport.sessions[0]?.closed).toBe(true)
    expect(transport.sessions[0]?.tunnelCloseCalls).toBe(1)
  })

  it('discards a tunnel failure that a disconnect superseded', async () => {
    let releaseTunnel: ((error: Error) => void) | undefined
    let markTunnelStarted: (() => void) | undefined
    const tunnelStarted = new Promise<void>((resolve) => {
      markTunnelStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.tunnelGate = new Promise<never>((_, reject) => {
      releaseTunnel = reject
    })
    session.tunnelStarted = () => markTunnelStarted?.()
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await tunnelStarted
    await manager.disconnect(MachineId('m1'))
    releaseTunnel!(new Error('tunnel setup failed'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'disconnected'])
  })

  it('marks the machine disconnected when the SSH session drops and reconnects it', async () => {
    const { manager, transport, emits, events } = boot()
    const first = await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.drop()
    // The drop hands the machine to the reconnect loop; the retry (1 ms in
    // the test config) succeeds against the fresh session.
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-reconnect')
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('connected')
    expect(status.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
    expect(manager.link(MachineId('m1'))).toBeDefined()
    expect(transport.connectCalls).toBe(2)
    // One publish for the schedule, one for the in-flight retry's progress.
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected'])
    expect(events.since(MachineId('m1')).events.some(event => event.stage === 'reconnect' && event.terminal === 'success')).toBe(true)
  })

  it('re-binds the same tunnel port across a drop reconnect', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    transport.sessions[0]!.drop()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-reconnect')
    expect(transport.sessions[1]!.preferredTunnelPort).toBe(49152)
  })

  it('reports the next retry hint while reconnecting', async () => {
    const { manager } = boot({
      sessionFactory: () => new FakeSession(() => true, new Error('connect ECONNREFUSED')),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    expect(manager.status(MachineId('m1')).state).toBe('reconnecting')
    // `nextRetryAt` 是本轮的 `Date.now() + delay`，而这里配置的首次退避只有 1ms；
    // 断言与调度共用毫秒时钟，慢机器上两者可以落在同一毫秒，写 `- 1` 会让等号也失败。
    // 留够一个调度周期的余量即可表达「重试已排到未来」的语义。
    expect(manager.status(MachineId('m1')).nextRetryAt).toBeGreaterThan(Date.now() - 50)
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).nextRetryAt).toBeUndefined()
  })

  it('ignores session-close callbacks that no longer own the state', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const oldSession = transport.sessions[0]!
    await manager.disconnect(MachineId('m1'))
    await manager.connect(MachineId('m1'))
    oldSession.drop()
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('swallows tunnel close failures when the session drops', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.tunnelCloseError = new Error('listener busy')
    session.drop()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-reconnect')
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('probes a machine with a remote banner', async () => {
    const session = new FakeSession(() => true)
    session.commands = []
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: true, banner: 'Linux 6.8.0-45-generic x86_64' })
    expect(session.commands).toEqual(['uname -srm'])
    expect(session.closed).toBe(true)
  })

  it('reports probe failures without throwing', async () => {
    const session = new FakeSession(() => true, undefined, undefined)
    session.exec = () => Promise.resolve({ code: 1, stdout: '', stderr: 'denied' })
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'exit 1: denied' })
  })

  it('reports transport failures during probes without throwing', async () => {
    const { manager } = boot({ rejectKeys: true })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'auth failed' })
  })

  it('reports exec failures during probes without throwing', async () => {
    const session = new FakeSession(() => true)
    session.exec = () => Promise.reject(new Error('channel reset'))
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'channel reset' })
  })

  it('reports non-Error probe failures without throwing', async () => {
    const session = new FakeSession(() => true)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a hostile non-Error rejection
    // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeSshFailure's String(error) arm
    session.exec = () => Promise.reject('plain string')
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'plain string' })
  })

  it('fails loud with an empty transport error message', async () => {
    const session = new FakeSession(() => true)
    // eslint-disable-next-line unicorn/error-message -- empty message on purpose: covers the 'SSH connection failed' fallback
    session.connectError = new Error('')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed', message: 'SSH connection failed' })
    const probe = await manager.test(MachineId('m1'))
    expect(probe).toEqual({ ok: false, message: 'SSH connection failed' })
  })

  it('fails loud with a non-Error bootstrap failure', async () => {
    const session = new FakeSession(() => false)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a hostile non-Error rejection
    // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeSshFailure's String(error) arm
    session.exec = () => Promise.reject('channel reset')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBe('channel reset')
  })

  it('swallows close failures during a failed bootstrap', async () => {
    const session = new FakeSession(() => false)
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(session.closeCalls).toBe(1)
  })

  it('exposes the startCommand override in profile views', () => {
    const { manager } = boot()
    const overridden: MachineProfile = { ...profile, startCommand: 'dsh web --port 4000' }
    machineTable.machines.set(MachineId('m1'), overridden)
    manager.refreshProfiles(new Map(machineTable.machines))
    expect(manager.profileViews()[0]?.startCommand).toBe('dsh web --port 4000')
  })

  it('rejects a mismatched host key (TOFU conflict)', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    transport.connect = async function (this: FakeTransport, p: MachineProfile, verifier: (label: string, key: Buffer) => boolean | Promise<boolean>, _options: RemoteTransportOptions, _signal?: AbortSignal): Promise<RemoteSession> {
      const accepted = await verifier(String(p.id), Buffer.from('other-key'))
      if (!accepted)
        throw new Error('Host key verification failed')
      const session = new FakeSession(() => true)
      this.sessions.push(session)
      return session
    }
    await manager.disconnect(MachineId('m1'))
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
  })

  it('disconnects machines whose profile vanished on refresh', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    manager.refreshProfiles(new Map([[secondProfile.id, secondProfile]]))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.status(MachineId('m2')).state).toBe('disconnected')
  })

  it('keeps a connected machine whose profile survives a refresh', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    manager.refreshProfiles(new Map([[profile.id, profile], [secondProfile.id, secondProfile]]))
    expect(manager.status(MachineId('m1')).state).toBe('connected')
    expect(manager.link(MachineId('m1'))).toBeDefined()
  })

  it('disposes every connection', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    await manager.connect(MachineId('m2'))
    await manager.dispose()
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.status(MachineId('m2')).state).toBe('disconnected')
  })

  it('marks dshMissing when the launch reports the runtime incomplete', async () => {
    const session = new FakeSession(index => index !== 0)
    session.startNotInstalled = true
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    const status = manager.status(MachineId('m1'))
    expect(status.dshMissing).toBe(true)
    // A missing runtime is persistent: the machine lands in given-up (not
    // the reconnect loop), freeing it for the install flow.
    expect(status.state).toBe('given-up')
    expect(status.lastError).toContain('REMOTE_NOT_INSTALLED')
  })

  it('clears the dshMissing marker on disconnect', async () => {
    const session = new FakeSession(index => index !== 0)
    session.startNotInstalled = true
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).dshMissing).toBeUndefined()
  })
})

describe('sshManager install', () => {
  it('installs dsh end-to-end, copies credentials, and auto-connects', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      const session = new FakeSession(index => sessions === 2 && index >= 1)
      if (sessions === 1)
        session.missingResult = 'node\ndsh\npnpm\n'
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      envCredentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://api.example.com' }),
    })
    const result = await manager.install(MachineId('m1'))
    expect(result).toEqual({
      installed: ['node', 'dsh', 'pnpm'],
      dshRef: 'dsh-0.1.2-rc.1-33729514615',
      dshVersion: '0.1.2-rc.1',
      dshPath: ENTRY,
      credentialsCopied: true,
    })
    const installSession = transport.sessions[0]!
    expect(installSession.commands[0]).toBe('uname -srm')
    expect(installSession.commands[1]).toContain('echo node')
    expect(installSession.commands[2]).toContain('https://nodejs.org/dist/')
    expect(installSession.commands[3]).toContain('test -f')
    expect(installSession.commands[4]).toContain('DEEPSEEK_API_KEY')
    expect(installSession.options[2]!.timeoutMs).toBe(60000)
    expect(typeof installSession.options[2]!.onData).toBe('function')
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect')
    expect(transport.connectCalls).toBe(2)
  })

  it('publishes the installing phase with the streaming install log', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.install(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'installing' })
    // Wait until the install script is in flight, then feed the streaming tap.
    await until(() => session.commands.some(command => command.includes('trap cleanup EXIT')), 'install exec')
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    session.options[installIndex]?.onData?.('==> downloading node\n')
    session.options[installIndex]?.onData?.('::dsh verify ok')
    expect(manager.status(MachineId('m1')).progress).toEqual({
      phase: 'installing',
      log: '==> downloading node\n::dsh verify ok',
    })
    await pending
  })

  it('dedupes concurrent installs onto one attempt', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager, transport } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const [a, b] = await Promise.all([manager.install(MachineId('m1')), manager.install(MachineId('m1'))])
    expect(a).toEqual(b)
    // One install exec (the auto-connect reuses the same session instance,
    // so dedupe the transport's session list before counting commands).
    const installRuns = [...new Set(transport.sessions)]
      .flatMap(session => session.commands)
      .filter(command => command.includes('trap cleanup EXIT'))
    expect(installRuns).toHaveLength(1)
  })

  it('skips the credentials copy when the local env has no key', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({}) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(session.commands.some(command => command.includes('DEEPSEEK_API_KEY'))).toBe(false)
  })

  it('keeps an existing remote key untouched', async () => {
    const session = new FakeSession(() => false)
    session.credentialsAnswer = 'existing'
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
  })

  it('reports a credentials write failure without failing the install', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => {
      if (command.includes('grep -q \'^DEEPSEEK_API_KEY=\''))
        return Promise.resolve({ code: 1, stdout: '', stderr: 'disk full' })
      if (command === 'uname -srm')
        return Promise.resolve({ code: 0, stdout: session.unameResult, stderr: '' })
      return Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? `${ENTRY}\n` : 'installed', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toContain('disk full')
  })

  it('settles the install with a terminal success event and line-buffered stream parsing', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager, events } = boot({ sessionFactory: () => session, envCredentials: () => ({}) })
    const pending = manager.install(MachineId('m1'))
    await until(() => session.commands.some(command => command.includes('trap cleanup EXIT')), 'install exec')
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    // A stage line split across two SSH chunks must surface as ONE event
    // with the full line, never two mangled halves.
    session.options[installIndex]?.onData?.('::dsh verify 警告: 远端缺少摘要工具，跳过校')
    session.options[installIndex]?.onData?.('验 node.tar.gz\n::dsh download https://example.test/a\n')
    releaseInstall!()
    const result = await pending
    expect(result.dshPath).toBe(ENTRY)
    const page = events.since(MachineId('m1'))
    const lines = page.events.map(event => `${event.stage}: ${event.line}`)
    expect(lines).toContain('verify: 警告: 远端缺少摘要工具，跳过校验 node.tar.gz')
    expect(lines).toContain('download: https://example.test/a')
    // The install operation settles on its own terminal event — independent
    // of the connect handoff — and carries the skipped-verification summary.
    const terminals = page.events.filter(event => event.terminal !== undefined)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'install', terminal: 'success' })
    expect(terminals[0]?.line).toContain('dsh 安装成功')
    expect(terminals[0]?.line).toContain('跳过校验项: 警告: 远端缺少摘要工具，跳过校验 node.tar.gz')
  })

  it('fails loud with machine-install-failed when the install command fails', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, options) => command.includes('trap cleanup EXIT')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'pnpm: not found' })
      : original(command, options)
    const { manager, events } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    // Capture the rejection: toMatchObject silently ignores message regexes,
    // so the message is asserted on the caught error directly.
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.code).toBe('machine-install-failed')
    // No streaming tap answered, so the failure keeps the exit stderr.
    expect(failure.message).toMatch(/install failed on remote \(exit 1\): pnpm: not found/)
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.progress).toBeUndefined()
    expect(session.closed).toBe(true)
    // The script's own failure settles the stream exactly once.
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed', line: 'install 失败' })
    expect(terminals[0]?.reason).toContain('pnpm: not found')
  })

  it('carries the installer output tail in a failed-install error', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, options) => {
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT')) {
        // The transport streams installer output before failing.
        options?.onData?.('==> downloading node\n')
        options?.onData?.('fatal: checksum mismatch')
        return Promise.resolve({ code: 11, stdout: '', stderr: 'verify failed' })
      }
      return original(command, options)
    }
    const { manager, events } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.code).toBe('machine-install-failed')
    // The streamed log wins over the collected stdout/stderr.
    expect(failure.message).toMatch(/install failed on remote \(exit 11\): ==> downloading node \| fatal: checksum mismatch/)
    expect(terminalsOf(events)).toHaveLength(1)
  })

  it('keeps the collected stdout tail when the transport has no streaming tap', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, _options) => command.includes('trap cleanup EXIT')
      // A tap-less transport: markers only in the collected stdout.
      ? Promise.resolve({ code: 10, stdout: '::dsh failed 所有下载源均失败: node.tar.gz', stderr: '' })
      : original(command, undefined)
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.message).toMatch(/install failed on remote \(exit 10\): .*所有下载源均失败/)
  })

  it('settles the install stream when the platform probe fails', async () => {
    const session = new FakeSession(() => false)
    const original = session.exec.bind(session)
    session.exec = (command, options) => command === 'uname -srm'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'denied' })
      : original(command, options)
    const { manager, events } = boot({ sessionFactory: () => session })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.code).toBe('machine-install-failed')
    expect(failure.message).toContain('cannot probe remote platform')
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed' })
    expect(terminals[0]?.reason).toContain('cannot probe remote platform')
  })

  it('settles the install stream when the platform probe reports an unsupported target', async () => {
    const session = new FakeSession(() => false)
    session.unameResult = 'MINGW64_NT-10.0-22631 3.4.10.x86_64 x86_64\n'
    const { manager, events } = boot({ sessionFactory: () => session })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.reason).toContain('REMOTE_PLATFORM_UNSUPPORTED')
  })

  it('settles the install stream when the install exec rejects (transport timeout)', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, options) => command.includes('trap cleanup EXIT')
      ? Promise.reject(new Error('install exec timed out after 60000ms'))
      : original(command, options)
    const { manager, events } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.code).toBe('machine-install-failed')
    expect(failure.message).toContain('timed out')
    // The timeout bypasses the script's own settling path — the catch must
    // close the stream so S4 sees the install as failed, not still running.
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed', line: 'install 失败' })
    expect(terminals[0]?.reason).toContain('timed out')
  })

  it('fails loud with machine-connect-failed when the install connection fails', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
    await untilSettled(manager)
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('given-up')
    expect(status.lastError).toBe('connect failed after 3 attempt(s): auth failed')
  })

  it('runs the install script with the configured timeout', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    await manager.install(MachineId('m1'))
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    expect(session.options[installIndex]!.timeoutMs).toBe(60000)
    expect(typeof session.options[installIndex]!.onData).toBe('function')
  })

  it('completes the install when the harness .env holds no credentials', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({}) })
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(ENTRY)
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toBeUndefined()
  })

  it('reads the harness home from the DSH_HOME environment variable', async () => {
    const previous = process.env.DSH_HOME
    try {
      // Left branch of the ?? : DSH_HOME set.
      process.env.DSH_HOME = join(tmpdir(), 'dsh-home-custom')
      const withVar = new FakeSession(() => false)
      await boot({ sessionFactory: () => withVar }).manager.install(MachineId('m1'))
      await settleRuntime()
      // Right branch: DSH_HOME unset (falls back to ~/.dsh).
      delete process.env.DSH_HOME
      const withoutVar = new FakeSession(() => false)
      await boot({ sessionFactory: () => withoutVar }).manager.install(MachineId('m1'))
    }
    finally {
      if (previous === undefined)
        delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('does not publish install state once a disconnect superseded the connection', async () => {
    const { manager, emits } = boot({ rejectKeys: true })
    const pending = manager.install(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    // The install start and the disconnect both published 'disconnected';
    // the superseded attempt itself never published.
    expect(emits.map(entry => entry.state)).toEqual(['disconnected', 'disconnected'])
  })

  it('reports a non-Error credentials failure without failing the install', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => {
      if (command.includes('grep -q \'^DEEPSEEK_API_KEY=\''))
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
        // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeExecFailure's message tail
        return Promise.reject('disk full')
      if (command === 'uname -srm')
        return Promise.resolve({ code: 0, stdout: session.unameResult, stderr: '' })
      return Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? `${ENTRY}\n` : 'installed', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toBe('disk full')
  })

  it('fails without publishing once a disconnect superseded an exec failure', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false, undefined, undefined, new Error('pnpm: not found'))
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager, events } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('trap cleanup EXIT'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    releaseInstall!()
    const failure = await pending.then(
      () => { throw new Error('expected a rejection') },
      error => error as RemoteError,
    )
    expect(failure.code).toBe('machine-install-failed')
    expect(failure.message).toMatch(/install failed on remote/)
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    // The script's own settling event fired inside the shared executor
    // before the supersede was noticed; the catch must not add a second.
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
  })

  it('fails loud when the install finished but the entry is not present', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => {
      if (command === 'uname -srm')
        return Promise.resolve({ code: 0, stdout: session.unameResult, stderr: '' })
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT'))
        return Promise.resolve({ code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' })
      if (command.includes('test -f '))
        // The remote `test -f` itself fails: the entry never landed.
        return Promise.resolve({ code: 1, stdout: '', stderr: '' })
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const { manager, events } = boot({ sessionFactory: () => session })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-dsh-missing',
      message: /entry .* is not present/,
    })
    // The exception path (RemoteError, not a script exit) settles the stream too.
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed' })
    expect(terminals[0]?.reason).toContain('is not present')
  })

  it('clears dshMissing after a successful install and reconnects', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      const session = new FakeSession(index => sessions >= 2 && index >= 1)
      if (sessions === 1)
        session.startNotInstalled = true
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      envCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).dshMissing).toBe(true)
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(ENTRY)
    expect(manager.status(MachineId('m1')).dshMissing).toBeUndefined()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect after install')
    expect(transport.connectCalls, JSON.stringify(events.since(MachineId('m1')))).toBe(3)
  })

  it('does not auto-connect when a disconnect superseded the install', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager, transport, events } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    const installIndex = await new Promise<number>((resolve) => {
      const timer = setInterval(() => {
        const index = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
        if (index >= 0) {
          clearInterval(timer)
          resolve(index)
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    // Output arriving after the supersede must not touch the published log.
    session.options[installIndex]?.onData?.('stale output')
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    releaseInstall!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-install-failed', message: /cancelled by disconnect/ })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport.connectCalls).toBe(1)
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    // Cancellation by an explicit disconnect is the documented no-terminal
    // case: the superseded attempt never publishes, not even a settle.
    expect(terminalsOf(events)).toHaveLength(0)
  })

  it('does not dial into the next runtime when a teardown lands mid-install', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await until(() => session.commands.some(command => command.includes('trap cleanup EXIT')), 'install script')
    // 下一个 runtime 已装配：在途 attempt 的续跑必须失效，否则它会读到新 runtime 的
    // transport，把连接计到别人的账上（host 单例 + deps 延迟解析下的串场）。
    const next = boot({ sessionFactory: () => new FakeSession(() => true) })
    releaseInstall!()
    await pending.catch(() => undefined)
    // 无修复时这里是 1：在途 attempt 的续跑借用下一个 runtime 的 transport 拨号。
    expect(next.transport.connectCalls).toBe(0)
    await expect(pending).rejects.toMatchObject({ code: 'machine-install-failed' })
  })

  it('returns the install result without connecting once a disconnect superseded the finish', async () => {
    let releaseCopy: (() => void) | undefined
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const session = new FakeSession(() => false)
    session.execGate = command => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'') ? copyGate : undefined
    const { manager, transport } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await until(() => session.commands.some(command => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')), 'credentials copy')
    await manager.disconnect(MachineId('m1'))
    releaseCopy!()
    const result = await pending
    expect(result.credentialsCopied).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport.connectCalls).toBe(1)
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
  })

  it('swallows a session close failure at the end of a successful install', async () => {
    const session = new FakeSession(() => false)
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(true)
    expect(result.credentialsError).toBeUndefined()
  })

  it('swallows a close failure during a failed install', async () => {
    const session = new FakeSession(() => false, undefined, undefined, new Error('pnpm: not found'))
    session.missingResult = 'node\n'
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    expect(session.closeCalls).toBe(1)
  })

  it('swallows a failed auto-connect after a successful install', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      // The install session is fine; the automatic connect session fails auth.
      return sessions === 1
        ? new FakeSession(() => false)
        : new FakeSession(() => true, new Error('auth failed'))
    }
    const { manager, transport } = boot({ sessionFactory: factory, envCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(true)
    // The auto-connect fails auth and its reconnect retries also fail: the
    // machine settles in the given-up terminal state with the auth reason.
    await until(() => manager.status(MachineId('m1')).state === 'given-up', 'auto-connect give-up')
    const status = manager.status(MachineId('m1'))
    expect(status.lastError).toContain('auth failed')
    expect(transport.connectCalls).toBeGreaterThan(2)
  })

  it('reports a non-Error install failure in the status', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    session.exec = (command, _options) => {
      if (command === 'uname -srm')
        return Promise.resolve({ code: 0, stdout: session.unameResult, stderr: '' })
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT'))
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
        // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers install failure normalization
        return Promise.reject('pnpm blew up')
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session, envCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBe('pnpm blew up')
  })
})

describe('sshManager reconnect', () => {
  /** Retry budget with distinguishable, fake-timer-friendly delays. */
  const fastRetry = { ...config, reconnectInitialDelayMs: 100, reconnectMaxDelayMs: 400, reconnectMaxAttempts: 3 }

  /** Sessions whose transport connect always fails with ECONNREFUSED. */
  const refused = (): FakeSession => new FakeSession(() => true, new Error('connect ECONNREFUSED 10.0.0.1:22'))

  it('backs off exponentially, caps the delay, and gives up after the budget', async () => {
    vi.useFakeTimers()
    try {
      const { manager, transport } = boot({ sessionFactory: refused, config: fastRetry })
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
      expect(manager.status(MachineId('m1')).state).toBe('reconnecting')
      expect(transport.connectCalls).toBe(1)
      // Retry 1 fires after the 100 ms initial delay — not before.
      await vi.advanceTimersByTimeAsync(99)
      expect(transport.connectCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.connectCalls).toBe(2)
      // Retry 2 doubles to 200 ms.
      await vi.advanceTimersByTimeAsync(199)
      expect(transport.connectCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.connectCalls).toBe(3)
      // Retry 3 caps at 400 ms.
      await vi.advanceTimersByTimeAsync(399)
      expect(transport.connectCalls).toBe(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.connectCalls).toBe(4)
      // Budget spent: the terminal given-up state with the summarized reason.
      const status = manager.status(MachineId('m1'))
      expect(status.state).toBe('given-up')
      expect(status.lastError).toBe('connect failed after 4 attempt(s): connect ECONNREFUSED 10.0.0.1:22')
      expect(status.nextRetryAt).toBeUndefined()
    }
    finally {
      await machine.dispose()
      vi.useRealTimers()
    }
  })

  it('stops retrying after a manual disconnect', async () => {
    vi.useFakeTimers()
    try {
      const { manager, transport } = boot({ sessionFactory: refused, config: fastRetry })
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
      await manager.disconnect(MachineId('m1'))
      expect(manager.status(MachineId('m1')).state).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.connectCalls).toBe(1)
    }
    finally {
      await machine.dispose()
      vi.useRealTimers()
    }
  })

  it('stops retrying when the machine profile vanishes', async () => {
    vi.useFakeTimers()
    try {
      const { manager, transport } = boot({ sessionFactory: refused, config: fastRetry })
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
      manager.refreshProfiles(new Map())
      expect(manager.status(MachineId('m1')).state).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.connectCalls).toBe(1)
    }
    finally {
      await machine.dispose()
      vi.useRealTimers()
    }
  })

  it('refuses connect and install while reconnecting with a distinct code', async () => {
    vi.useFakeTimers()
    try {
      const { manager } = boot({ sessionFactory: refused, config: fastRetry })
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-reconnecting' })
      await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-reconnecting' })
      // 专用会话（sync 引擎入口）同样拒绝——与 connect/install 的在途一致
      // 性语义对称，不并行建连。
      await expect(manager.openSession(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-reconnecting' })
    }
    finally {
      await machine.dispose()
      vi.useRealTimers()
    }
  })

  it('uses the edited profile on the next retry', async () => {
    // Real timers: the retry goes through TOFU file I/O, which the fake
    // clock would not wait for.
    let calls = 0
    const factory = (): FakeSession => {
      calls += 1
      // The first connect fails; retries (after the profile edit) succeed.
      return calls === 1 ? refused() : new FakeSession(() => true)
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      config: { ...config, reconnectInitialDelayMs: 5, reconnectMaxDelayMs: 10, reconnectMaxAttempts: 3 },
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
    // The operator fixes the profile mid-outage (e.g. a new password).
    manager.refreshProfiles(new Map([[MachineId('m1'), { ...profile, host: '10.0.0.9' }], [secondProfile.id, secondProfile]]))
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'retry with edited profile')
    expect(transport.profiles[1]?.host).toBe('10.0.0.9')
  })

  it('gives up without retrying when dsh is missing', async () => {
    // The launch verdict REMOTE_NOT_INSTALLED is the merged flow's
    // dsh-missing signal (the auto-bootstrap could not complete).
    const session = new FakeSession(index => index !== 0)
    session.startNotInstalled = true
    const { manager, transport } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
    expect(manager.status(MachineId('m1')).dshMissing).toBe(true)
    expect(transport.connectCalls).toBe(1)
  })

  it('keeps the launch token out of the link and reads it only when the gateway mints', async () => {
    const { manager, transport } = boot({
      sessionFactory: () => {
        const session = new FakeSession(() => true)
        session.webTokenResult = 'tok-abc-123\n'
        return session
      },
    })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(link.tunnelBaseUrl).not.toContain('tok-abc-123')
    expect(JSON.stringify(manager.statuses())).not.toContain('tok-abc-123')
    expect(transport.sessions[0]?.commands.some(command => command.startsWith('grep -oE \'token='))).toBe(false)
  })

  it('syncs the supplied plugin tree before ensuring the instance', async () => {
    const session = new FakeSession(() => true)
    const { manager, events } = boot({ sessionFactory: () => session })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toContain('http://127.0.0.1:')
    expect(session.commands.some(command => command.startsWith('cat "$HOME/.dsh-desktop/plugins'))).toBe(true)
    expect(session.commands.some(command => command.includes('PLUGINS_SYNCED'))).toBe(true)
    const upload = session.options[session.commands.findIndex(command => command.includes('PLUGINS_SYNCED'))]?.stdinData
    expect(upload).toBeInstanceOf(Buffer)
    const manifest = execFileSync('tar', ['-xOzf', '-', './dsh-tauri-remote/package.json'], { input: upload, encoding: 'utf8' })
    expect(JSON.parse(manifest)).toEqual({ name: 'dsh-tauri-remote', dsh: { bundle: {} } })
    expect(events.since(MachineId('m1')).events.map(event => event.line).some(line => line.includes('捆绑插件已同步'))).toBe(true)
  })

  it('a plugin-sync failure degrades to the stock remote UI without failing the connect', async () => {
    const { manager, events } = boot({
      sessionFactory: () => {
        const session = new FakeSession(() => true)
        session.pluginSyncError = new Error('upload broke')
        return session
      },
    })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toContain('http://127.0.0.1:')
    const lines = events.since(MachineId('m1')).events.map(event => event.line)
    expect(lines.some(line => line.includes('捆绑插件同步失败'))).toBe(true)
  })

  it('mints the DSH session cookie through the gateway on first access', async () => {
    const standIn = await remoteStandIn()
    try {
      const { manager, transport } = boot({ sessionFactory: () => standInSession(standIn) })
      const link = await manager.connect(MachineId('m1'))
      // 连接阶段不铸造：网关只在首次访问时取用启动 token
      expect(standIn.records).toEqual([])
      const response = await getThrough(link.tunnelBaseUrl)
      expect(response.status).toBe(200)
      expect(response.body).toBe('dsh-ok')
      expect(standIn.records.map(record => record.url)).toEqual(['/?token=tok-abc-123', '/'])
      expect(standIn.records[0]?.host).toBe(`127.0.0.1:${new URL(link.tunnelBaseUrl).port}`)
      expect(standIn.records[1]?.cookie).toBe('dsh-session=tok-abc-123')
      expect(transport.sessions[0]?.closed).toBe(false)
    }
    finally {
      await standIn.close()
    }
  })

  it('re-reads the remote launch token to re-mint after the remote instance restarts', async () => {
    const standIn = await remoteStandIn()
    try {
      const { manager, transport } = boot({ sessionFactory: () => standInSession(standIn) })
      const link = await manager.connect(MachineId('m1'))
      expect((await getThrough(link.tunnelBaseUrl)).status).toBe(200)
      // 远端实例重启：日志里的 token 变了，旧 cookie 随即失效
      standIn.sessionCookie('dsh-session=tok-next-456')
      transport.sessions[0]!.webTokenResult = 'tok-next-456\n'
      const after = await getThrough(link.tunnelBaseUrl)
      expect(after.status).toBe(200)
      expect(after.body).toBe('dsh-ok')
      expect(standIn.records.filter(record => record.url.startsWith('/?token=')).map(record => record.url)).toEqual(['/?token=tok-abc-123', '/?token=tok-next-456'])
      expect(standIn.records.at(-1)?.cookie).toBe('dsh-session=tok-next-456')
      expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
    }
    finally {
      await standIn.close()
    }
  })

  it('declares identity and the gateway authority to the remote instance', async () => {
    const standIn = await remoteStandIn()
    try {
      const { manager } = boot({
        sessionFactory: () => {
          const session = new FakeSession(() => true)
          session.tunnelPort = standIn.port
          return session
        },
      })
      const link = await manager.connect(MachineId('m1'))
      await getThrough(link.tunnelBaseUrl)
      expect(standIn.records).toHaveLength(1)
      expect(standIn.records[0]?.url).toBe('/')
      expect(standIn.records[0]?.host).toBe(`127.0.0.1:${new URL(link.tunnelBaseUrl).port}`)
      expect(standIn.records[0]?.encoding).toBe('identity')
    }
    finally {
      await standIn.close()
    }
  })

  it('keeps the link alive when the remote launch token cannot be read, then mints on the next access', async () => {
    const standIn = await remoteStandIn()
    try {
      const { manager, transport, events } = boot({
        sessionFactory: () => {
          const session = new FakeSession(() => true)
          session.tunnelPort = standIn.port
          return session
        },
      })
      const link = await manager.connect(MachineId('m1'))
      const denied = await getThrough(link.tunnelBaseUrl)
      expect(denied.status).toBe(401)
      expect(standIn.records.map(record => record.url)).toEqual(['/'])
      expect(manager.status(MachineId('m1')).state).toBe('connected')
      expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      // 铸造失败必须留下一条可读事件：它是发现「远端实例重启」的唯一线索
      expect(events.since(MachineId('m1')).events.map(event => event.line)).toContainEqual(
        expect.stringContaining('DSH 原生 cookie 铸造失败（token 不可用）'),
      )
      // 失败的铸造不得被缓存：token 恢复后无需重连即可铸造成功
      transport.sessions[0]!.webTokenResult = 'tok-abc-123\n'
      const allowed = await getThrough(link.tunnelBaseUrl)
      expect(allowed.status).toBe(200)
      expect(allowed.body).toBe('dsh-ok')
      expect(standIn.records.map(record => record.url)).toEqual(['/', '/?token=tok-abc-123', '/'])
    }
    finally {
      await standIn.close()
    }
  })

  it('runs one outbound gateway entry per connected machine, upstreamed at its tunnel port', async () => {
    const { manager, transport } = boot()
    const link = await manager.connect(MachineId('m1'))
    expect(gateway.list()).toEqual([
      expect.objectContaining({
        id: 'remote-outbound:m1',
        kind: 'outbound',
        state: 'listening',
        host: '127.0.0.1',
        url: link.tunnelBaseUrl,
        upstream: `http://127.0.0.1:${transport.sessions[0]!.tunnelPort}`,
      }),
    ])
    await manager.disconnect(MachineId('m1'))
    expect(gateway.list()).toEqual([expect.objectContaining({ id: 'remote-outbound:m1', state: 'stopped', port: 0 })])
    expect(manager.status(MachineId('m1')).tunnelBaseUrl).toBeUndefined()
  })

  it('gives each connected machine its own gateway port', async () => {
    const { manager } = boot()
    const first = await manager.connect(MachineId('m1'))
    const second = await manager.connect(MachineId('m2'))
    expect(first.tunnelBaseUrl).not.toBe(second.tunnelBaseUrl)
    expect(gateway.list().map(entry => entry.url).sort()).toEqual([first.tunnelBaseUrl, second.tunnelBaseUrl].sort())
  })

  it('does not report connected before the gateway entry is listening', async () => {
    const { manager } = boot()
    const original = gateway.start
    const observed: string[] = []
    const start = vi.spyOn(gateway, 'start').mockImplementation(async (options) => {
      observed.push(manager.status(MachineId('m1')).state)
      return await original(options)
    })
    const link = await manager.connect(MachineId('m1'))
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[0]).toMatchObject({ id: 'remote-outbound:m1', kind: 'outbound' })
    expect(observed).toEqual(['connecting'])
    expect(manager.status(MachineId('m1')).state).toBe('connected')
    expect(manager.status(MachineId('m1')).tunnelBaseUrl).toBe(link.tunnelBaseUrl)
  })

  it('reuses the gateway port after a disconnect so the link survives a manual reconnect', async () => {
    const { manager } = boot()
    const first = await manager.connect(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    const again = await manager.connect(MachineId('m1'))
    expect(again.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
  })

  it('dials the retry only after the previous gateway teardown has landed', async () => {
    const order: string[] = []
    const { manager, transport } = boot({
      sessionFactory: () => {
        order.push('dial')
        return new FakeSession(() => true)
      },
    })
    const first = await manager.connect(MachineId('m1'))
    const original = gateway.stop
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(gateway, 'stop').mockImplementation(async (id) => {
      order.push('teardown')
      await gate
      await original(id)
      order.push('teardown-done')
    })
    transport.sessions[0]!.drop()
    const due = machineStates.get(MachineId('m1'))!.reconnect?.nextRetryAt
    expect(due).toBeTypeOf('number')
    // 退避已到期（+50ms 余量）而回收仍未落地：此刻不许再拨号
    await until(() => Date.now() > (due ?? 0) + 50, 'retry window passed')
    expect(order).toEqual(['dial', 'teardown'])
    release()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'reconnect after teardown')
    expect(order).toEqual(['dial', 'teardown', 'teardown-done', 'dial'])
    expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
  })

  it('reconnects when the gateway entry dies behind the machine', async () => {
    const standIn = await remoteStandIn()
    try {
      const { manager } = boot({ sessionFactory: () => standInSession(standIn) })
      const first = await manager.connect(MachineId('m1'))
      await gateway.stop('remote-outbound:m1')
      await until(() => manager.status(MachineId('m1')).state === 'reconnecting', 'reconnecting after gateway stop')
      await until(() => manager.status(MachineId('m1')).state === 'connected', 'gateway restart')
      expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
      expect((await getThrough(first.tunnelBaseUrl)).status).toBe(200)
    }
    finally {
      await standIn.close()
    }
  })

  it('keeps the link through a per-request upstream failure and serves again once the instance is back', async () => {
    const standIn = await remoteStandIn()
    let instanceAlive = true
    const hop = await hopThrough(standIn.port, () => instanceAlive)
    const { manager, transport, events } = boot({
      sessionFactory: () => {
        const session = standInSession(standIn)
        session.tunnelPort = hop.port
        return session
      },
    })
    try {
      const link = await manager.connect(MachineId('m1'))
      // 远端实例停机而隧道口（hop）仍在监听：只有转发到实例的那一跳失败
      instanceAlive = false
      const denied = await getThrough(link.tunnelBaseUrl)
      expect(denied.status).toBe(502)
      expect(denied.body).toContain('上游不可达')
      // 死的是远端实例而不是链路：SSH 会话与入口都不得被拆掉
      expect(transport.sessions[0]?.closed).toBe(false)
      expect(gateway.list()).toEqual([expect.objectContaining({ id: 'remote-outbound:m1', state: 'listening' })])
      expect(manager.status(MachineId('m1')).state).toBe('connected')
      expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      await until(() => (manager.status(MachineId('m1')).lastError ?? '').includes('上游不可达'), 'readable per-request failure')
      expect(events.since(MachineId('m1')).events.some(event => event.line.includes('上游不可达'))).toBe(true)
      // 实例原地恢复即恢复服务，无需任何重连
      instanceAlive = true
      const served = await getThrough(link.tunnelBaseUrl)
      expect(served.status).toBe(200)
      expect(served.body).toBe('dsh-ok')
      expect(manager.status(MachineId('m1')).state).toBe('connected')
    }
    finally {
      await standIn.close()
      await hop.close()
    }
  })

  it('reconnects when the upstream tunnel dies behind the gateway', async () => {
    let standIn = await remoteStandIn()
    const port = standIn.port
    const { manager } = boot({ sessionFactory: () => standInSession(standIn) })
    try {
      const link = await manager.connect(MachineId('m1'))
      // 隧道口本身消失：同一端口不再有监听，网关转发与链路探测都拿到 ECONNREFUSED
      await standIn.close()
      const response = await getThrough(link.tunnelBaseUrl)
      expect(response.status).toBe(502)
      expect(response.body).toContain('上游不可达')
      await until(() => manager.status(MachineId('m1')).state === 'reconnecting', 'reconnecting after upstream kill')
      standIn = await remoteStandIn(port)
      await until(() => manager.status(MachineId('m1')).state === 'connected', 'reconnect after upstream kill')
      expect(manager.status(MachineId('m1')).state).toBe('connected')
      expect((await getThrough(manager.link(MachineId('m1'))!.tunnelBaseUrl)).status).toBe(200)
    }
    finally {
      await standIn.close()
    }
  })

  it('gives up with a readable reason when every gateway candidate port is taken', async () => {
    const { manager, transport } = boot()
    const first = await manager.connect(MachineId('m1'))
    const remembered = Number(new URL(first.tunnelBaseUrl).port)
    await manager.disconnect(MachineId('m1'))
    const range = await occupyRange(GATEWAY_CANDIDATES, remembered)
    machineStates.get(MachineId('m1'))!.preferredGatewayPort = range.base
    try {
      await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
      const status = manager.status(MachineId('m1'))
      expect(status.state).toBe('given-up')
      expect(status.lastError).toMatch(/网关端口全部占用/u)
      expect(status.nextRetryAt).toBeUndefined()
      expect(manager.link(MachineId('m1'))).toBeUndefined()
      expect(transport.sessions.at(-1)?.closed).toBe(true)
      expect(transport.sessions.at(-1)?.tunnelCloseCalls).toBe(1)
    }
    finally {
      await closeServers(range.servers)
    }
  })

  it('rebuilds the outbound entry after a full gateway teardown', async () => {
    const { manager } = boot()
    const first = await manager.connect(MachineId('m1'))
    await gateway.dispose()
    expect(gateway.list()).toEqual([])
    await until(() => manager.status(MachineId('m1')).state === 'reconnecting', 'reconnecting after gateway teardown')
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'gateway rebuilt')
    expect(gateway.list()).toEqual([expect.objectContaining({ id: 'remote-outbound:m1', kind: 'outbound', state: 'listening' })])
    expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
  })

  it('closes the gateway when the machine profile vanishes', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    manager.refreshProfiles(new Map([[secondProfile.id, secondProfile]]))
    await until(() => gateway.list().every(entry => entry.state === 'stopped'), 'gateway teardown')
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('exits given-up on a fresh connect', async () => {
    let fail = true
    const factory = (): FakeSession => fail ? refused() : new FakeSession(() => true)
    const { manager } = boot({ sessionFactory: factory })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
    fail = false
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('scrubs stored secrets from lastError, statuses, and events', async () => {
    const leaky = (): FakeSession => new FakeSession(() => true, new Error('auth failed for password "sekrit"'))
    const { manager, emits, events } = boot({ sessionFactory: leaky })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).lastError).not.toContain('sekrit')
    expect(manager.status(MachineId('m1')).lastError).toContain('***')
    expect(JSON.stringify(manager.statuses())).not.toContain('sekrit')
    expect(JSON.stringify(emits)).not.toContain('sekrit')
    expect(JSON.stringify(events.since(MachineId('m1')))).not.toContain('sekrit')
  })

  it('emits auth and reconnect stage events across the give-up run', async () => {
    const { manager, events } = boot({ sessionFactory: refused })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    await untilSettled(manager)
    const page = events.since(MachineId('m1'))
    const stages = page.events.map(event => `${event.stage}${event.terminal === undefined ? '' : `:${event.terminal}`}`)
    expect(stages.filter(stage => stage === 'auth')).toHaveLength(3)
    expect(stages).toContain('reconnect:failed')
    expect(page.events.at(-1)?.line).toContain('connect failed after 3 attempt(s)')
  })

  it('publishes the transient testing state around a probe', async () => {
    const session = new FakeSession(() => true)
    let markProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    session.exec = () => {
      markProbeStarted?.()
      return new Promise(resolve => setTimeout(resolve, 10, { code: 0, stdout: 'Linux x86_64', stderr: '' }))
    }
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.test(MachineId('m1'))
    await probeStarted
    expect(manager.status(MachineId('m1')).state).toBe('testing')
    const result = await pending
    expect(result).toEqual({ ok: true, banner: 'Linux x86_64' })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('restores the given-up phase after a probe', async () => {
    let fail = true
    const factory = (): FakeSession => fail ? refused() : new FakeSession(() => true)
    const { manager } = boot({ sessionFactory: factory })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    await untilSettled(manager)
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
    fail = false
    const result = await manager.test(MachineId('m1'))
    expect(result.ok).toBe(true)
    expect(manager.status(MachineId('m1')).state).toBe('given-up')
  })

  it('does not let a probe restore a phase that changed underneath it', async () => {
    const session = new FakeSession(() => true)
    let releaseProbe: (() => void) | undefined
    let markProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    session.exec = () => new Promise((resolve) => {
      markProbeStarted?.()
      releaseProbe = () => resolve({ code: 0, stdout: 'Linux x86_64', stderr: '' })
    })
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.test(MachineId('m1'))
    await probeStarted
    // A disconnect takes ownership while the probe still runs.
    await manager.disconnect(MachineId('m1'))
    releaseProbe!()
    await pending
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })
})

describe('transport capability branches', () => {
  it('answers test() with a disabled message instead of dialing when the transport cannot exec', async () => {
    const { manager, transport } = boot({ capabilities: { exec: false } })
    await expect(manager.test(MachineId('m1'))).resolves.toEqual({ ok: false, message: expect.stringContaining('cannot exec') })
    expect(transport.connectCalls).toBe(0)
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('rejects connect() without dialing or scheduling a reconnect when the transport cannot exec', async () => {
    const { manager, transport } = boot({ capabilities: { exec: false } })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-transport-unsupported' })
    expect(transport.connectCalls).toBe(0)
    expect(machineStates.get(MachineId('m1'))?.reconnect).toBeUndefined()
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('rejects connect() when the transport declares exec but cannot stream', async () => {
    const { manager, transport } = boot({ capabilities: { stream: false } })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-transport-unsupported', message: expect.stringContaining('cannot stream') })
    expect(transport.connectCalls).toBe(0)
    expect(machineStates.get(MachineId('m1'))?.reconnect).toBeUndefined()
  })

  it('rejects install() and openSession() when the transport cannot exec', async () => {
    const { manager, transport } = boot({ capabilities: { exec: false } })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-transport-unsupported' })
    await expect(manager.openSession(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-transport-unsupported' })
    expect(transport.connectCalls).toBe(0)
  })

  it('still connects when the transport declares both capabilities', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    expect(transport.connectCalls).toBe(1)
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })
})
