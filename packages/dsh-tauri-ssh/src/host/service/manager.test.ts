import type { MachineProfile, SshMachineEvent } from '../types/index'
import type { RemoteInstallPlan } from './bootstrap'
import type { SshExecOptions, SshExecResult, SshSession, SshTransport, SshTunnelHandle } from './transport'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineId, SshError } from '../types/index'
import { SshMachineEvents } from './events'
import { KnownHostsStore } from './host-keys'
import { SshManager } from './manager'

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
  installTimeoutMs: 60000,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 2,
  reconnectMaxAttempts: 2,
}

/** A boot page whose manifest the bundle probe confirms. */
const BOOT_HTML = '<html><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>'

/** The layout entry the v2 install resolves (see {@link fakePlan}): the remote shell expands $HOME (root user in the fake). */
const ENTRY = '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

/** A literal linux/x64 plan (no network): the recommended pin with digest. */
function fakePlan(): RemoteInstallPlan {
  return {
    os: 'linux',
    arch: 'x64',
    matrix: { os: 'linux', arch: 'x64', dshKind: 'pkg-zip', nodeFilename: 'node-v22.22.0-linux-x64.tar.gz', dshZipName: 'deepseek-harness-pkg-linux.zip' },
    repo: 'dsh-tauri-desk/deepseek-harness-pkg',
    dshEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    dshVersion: '0.1.2-rc.1',
    node: {
      urls: ['https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz'],
      shasumUrls: ['https://nodejs.org/dist/v22.22.0/SHASUMS256.txt'],
      filename: 'node-v22.22.0-linux-x64.tar.gz',
      version: 'v22.22.0',
    },
    dsh: {
      kind: 'pkg-zip',
      urls: ['https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.2-rc.1-33729514615/deepseek-harness-pkg-linux.zip'],
      digest: 'sha256:6b7ecfeb',
      zipName: 'deepseek-harness-pkg-linux.zip',
      tag: 'dsh-0.1.2-rc.1-33729514615',
    },
    pnpm: { urls: ['https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz'], sha256: 'deaf'.repeat(16), version: '11.7.0' },
    notes: [],
  }
}

class FakeSession implements SshSession {
  commands: string[] = []
  options: SshExecOptions[] = []
  closed = false
  tunnel: SshTunnelHandle | undefined
  closeCalls = 0
  tunnelCloseCalls = 0
  closeError: Error | undefined
  tunnelCloseError: Error | undefined
  tunnelGate: Promise<void> | undefined
  tunnelStarted: (() => void) | undefined
  execGate: ((command: string, index: number) => Promise<void> | undefined) | undefined
  /** The preferred local port the last openTunnel call received. */
  preferredTunnelPort: number | undefined
  authMethod: SshSession['authMethod'] = 'key'
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
  /** Whether the launch answered REMOTE_NOT_INSTALLED instead of starting. */
  startNotInstalled = false
  /** The web-log token grep answer (default: no token → bare tunnel URL). */
  webTokenResult = ''

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult> {
    this.commands.push(command)
    this.options.push(options ?? {})
    const respond = (): SshExecResult => {
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

  /** The injection slot the last openTunnel call received. */
  tunnelInjection: { cookie: string | undefined } | undefined

  async openTunnel(_remotePort: number, preferredLocalPort?: number, injection?: { cookie: string | undefined }): Promise<SshTunnelHandle> {
    this.tunnelInjection = injection
    this.preferredTunnelPort = preferredLocalPort
    this.tunnelStarted?.()
    if (this.tunnelGate !== undefined)
      await this.tunnelGate
    this.tunnel = {
      localPort: 49152,
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

class FakeTransport implements SshTransport {
  sessions: FakeSession[] = []
  connectCalls = 0
  hostKeys: Array<{ key: Buffer, accepted: boolean }> = []
  rejectKeys = false
  /** The profile each connect call received (the loop must re-read edits). */
  profiles: MachineProfile[] = []

  constructor(private readonly sessionFactory: () => FakeSession) {}

  async connect(
    profile: MachineProfile,
    hostKeyVerifier: (label: string, key: Buffer) => boolean | Promise<boolean>,
  ): Promise<SshSession> {
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

function tempKnownHosts(): KnownHostsStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-manager-'))
  roots.push(root)
  return new KnownHostsStore(join(root, 'known-hosts.json'))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The bootstrap flow's own commands, without the connect-time prelude (the
 * idempotent pnpm-shim write). Flow assertions stay about the bootstrap, and
 * a new prelude step never renumbers them.
 */
/** The connect-time prelude markers (pnpm shim, build-allowlist carry). */
const PRELUDE_MARKERS = ['chmod +x "$B/pnpm"', 'pnpm-workspace.yaml']

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
async function untilSettled(manager: SshManager, machineId: MachineId = MachineId('m1')): Promise<void> {
  await until(() => {
    const state = manager.status(machineId).state
    return state === 'given-up' || state === 'connected' || state === 'disconnected'
  }, 'terminal state')
}

function boot(overrides: Partial<{
  sessionFactory: () => FakeSession
  rejectKeys: boolean
  readEnvCredentials: () => { apiKey?: string, baseUrl?: string }
  config: typeof config
  planInstall: () => Promise<RemoteInstallPlan>
  mintCookie: (authenticatedUrl: string) => Promise<string | undefined>
  syncPlugins: (session: import('./transport').SshSession, profileName: string, remotePort: number, hooks: { onEvent?: (stage: import('../types/index').SshMachineStage, line: string) => void }) => Promise<boolean>
  localAllowlist: () => import('./allowlist').WorkspaceAllowlist
}> = {}) {
  const transport = new FakeTransport(overrides.sessionFactory ?? (() => new FakeSession(() => true)))
  transport.rejectKeys = overrides.rejectKeys ?? false
  const emits: Array<{ id: MachineId, state: string, progress?: { phase: string } }> = []
  const events = new SshMachineEvents()
  const plan = fakePlan()
  const manager = new SshManager({
    transport,
    knownHosts: tempKnownHosts(),
    config: overrides.config ?? config,
    events,
    planInstall: overrides.planInstall ?? (() => Promise.resolve(plan)),
    // 默认离线 mint：不走真实 HTTP；个别用例经 overrides 覆盖
    mintCookie: overrides.mintCookie ?? (() => Promise.resolve(undefined)),
    // 默认离线插件同步：不打本地 tar；个别用例经 overrides 覆盖
    syncPlugins: overrides.syncPlugins ?? (() => Promise.resolve(false)),
    ...overrides.localAllowlist === undefined ? {} : { localAllowlist: overrides.localAllowlist },
    ...overrides.readEnvCredentials === undefined ? {} : { readEnvCredentials: overrides.readEnvCredentials },
    emitStatus: (id, status) => {
      emits.push({ id, state: status.state, ...status.progress === undefined ? {} : { progress: status.progress } })
    },
  })
  manager.refreshProfiles(new Map([[profile.id, profile], [secondProfile.id, secondProfile]]))
  return { manager, transport, emits, events }
}

/** The terminal (settling) events one machine's channel recorded. */
function terminalsOf(events: SshMachineEvents): SshMachineEvent[] {
  return events.since(MachineId('m1')).events.filter(event => event.terminal !== undefined)
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

  it('connects a healthy machine and publishes the link', async () => {
    const { manager, transport, emits } = boot()
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toBe('http://127.0.0.1:49152')
    expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
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
    manager.setProgress(MachineId('m1'), { phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-ssh' })
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-ssh' })
    manager.setProgress(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    expect(emits.map(entry => entry.progress)).toEqual([
      { phase: 'syncing', attempt: 3, total: 13, item: 'dsh-tauri-ssh' },
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
    session.execGate = command => command.includes('dsh-remote.pid') ? startGate : undefined
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    // Wait until the start command is in flight, then supersede the attempt.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('dsh-remote.pid'))) {
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
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow(SshError)
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
    expect(manager.status(MachineId('m1')).nextRetryAt).toBeGreaterThan(Date.now() - 1)
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
    manager.refreshProfiles(new Map([[MachineId('m1'), overridden]]))
    expect(manager.profileViews()[0]?.startCommand).toBe('dsh web --port 4000')
  })

  it('rejects a mismatched host key (TOFU conflict)', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    transport.connect = async function (this: FakeTransport, p: MachineProfile, verifier: (label: string, key: Buffer) => boolean | Promise<boolean>): Promise<SshSession> {
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
    // Session 1 = install (platform probe, missing check, install script,
    // entry check, credentials copy); session 2 = the automatic connect
    // (root probe refused, platform probe, missing check, launch, healthy).
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
      readEnvCredentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://api.example.com' }),
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
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({}) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(session.commands.some(command => command.includes('DEEPSEEK_API_KEY'))).toBe(false)
  })

  it('keeps an existing remote key untouched', async () => {
    const session = new FakeSession(() => false)
    session.credentialsAnswer = 'existing'
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
  })

  it('reports a credentials write failure without failing the install', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'disk full' })
      : Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? `${ENTRY}\n` : 'installed', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
    const { manager, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({}) })
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
    const { manager, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    // Capture the rejection: toMatchObject silently ignores message regexes,
    // so the message is asserted on the caught error directly.
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as SshError,
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
    const { manager, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as SshError,
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
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as SshError,
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
      error => error as SshError,
    )
    expect(failure.code).toBe('machine-install-failed')
    expect(failure.message).toContain('cannot probe remote platform')
    const terminals = terminalsOf(events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ stage: 'failed', terminal: 'failed' })
    expect(terminals[0]?.reason).toContain('cannot probe remote platform')
  })

  it('settles the install stream when the planner rejects the platform', async () => {
    const session = new FakeSession(() => false)
    const { manager, events } = boot({
      sessionFactory: () => session,
      planInstall: () => Promise.reject(new Error('REMOTE_PLATFORM_UNSUPPORTED: mingw/x64 outside the asset matrix')),
    })
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
    const { manager, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const failure = await manager.install(MachineId('m1')).then(
      () => { throw new Error('expected a rejection') },
      error => error as SshError,
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

  it('runs without an install timeout when the config omits it', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager } = boot({
      sessionFactory: () => session,
      config: { ...config, installTimeoutMs: undefined as unknown as number },
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await manager.install(MachineId('m1'))
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    expect(session.options[installIndex]!.timeoutMs).toBeUndefined()
    expect(typeof session.options[installIndex]!.onData).toBe('function')
  })

  it('falls back to the local harness .env when no credentials reader is injected', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session })
    // No readEnvCredentials injection: the manager reads the host's own
    // $DSH_HOME/.env — whatever it holds, the install still completes.
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(ENTRY)
    expect(result.credentialsError).toBeUndefined()
  })

  it('reads the harness home from the DSH_HOME environment variable', async () => {
    const previous = process.env.DSH_HOME
    try {
      // Left branch of the ?? : DSH_HOME set.
      process.env.DSH_HOME = join(tmpdir(), 'dsh-home-custom')
      const withVar = new FakeSession(() => false)
      await boot({ sessionFactory: () => withVar }).manager.install(MachineId('m1'))
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
    session.exec = (command, _options) => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeExecFailure's message tail
      ? Promise.reject('disk full')
      : Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? `${ENTRY}\n` : 'installed', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
    const { manager, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
      error => error as SshError,
    )
    expect(failure.code).toBe('machine-install-failed')
    expect(failure.message).toMatch(/install failed on remote/)
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    // The script's own settling event fired inside the shared executor
    // before the supersede was noticed; the catch must not add a second.
    expect(terminalsOf(events)).toHaveLength(1)
  })

  it('fails loud when the install finished but the entry is not present', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => {
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
    // The exception path (SshError, not a script exit) settles the stream too.
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
      // The first (failed) connect finds the runtime incomplete; the install
      // and the auto-connect see it whole.
      if (sessions === 1)
        session.startNotInstalled = true
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).dshMissing).toBe(true)
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(ENTRY)
    expect(manager.status(MachineId('m1')).dshMissing).toBeUndefined()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect after install')
    // First (failed) connect + install + auto-connect.
    expect(transport.connectCalls).toBe(3)
  })

  it('does not auto-connect when a disconnect superseded the install', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager, transport, events } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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

  it('returns the install result without connecting once a disconnect superseded the finish', async () => {
    let releaseCopy: (() => void) | undefined
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const session = new FakeSession(() => false)
    session.execGate = command => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'') ? copyGate : undefined
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(true)
    expect(result.credentialsError).toBeUndefined()
  })

  it('swallows a close failure during a failed install', async () => {
    const session = new FakeSession(() => false, undefined, undefined, new Error('pnpm: not found'))
    session.missingResult = 'node\n'
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
    const { manager, transport } = boot({ sessionFactory: factory, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT'))
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
        // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers install failure normalization
        return Promise.reject('pnpm blew up')
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
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

  it('publishes the tunnel URL with the launch token when the remote log has one', async () => {
    // 远端 web 日志带 token：隧道 URL 附带 ?token=（首次加载 mint 鉴权 cookie）
    const { manager } = boot({
      sessionFactory: () => {
        const session = new FakeSession(() => true)
        session.webTokenResult = 'tok-abc-123\n'
        return session
      },
    })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toBe('http://127.0.0.1:49152/?token=tok-abc-123')
    expect(manager.status(MachineId('m1')).tunnelBaseUrl).toBe('http://127.0.0.1:49152/?token=tok-abc-123')
  })

  it('syncs bundled plugins before ensuring the instance (failure degrades, never blocks)', async () => {
    const calls: string[] = []
    const { manager } = boot({
      syncPlugins: () => {
        calls.push('sync')
        return Promise.resolve(true)
      },
    })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toContain('http://127.0.0.1:')
    expect(calls).toEqual(['sync'])
  })

  it('a plugin-sync failure degrades to the stock remote UI without failing the connect', async () => {
    const { manager, events } = boot({
      syncPlugins: () => Promise.reject(new Error('upload broke')),
    })
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toContain('http://127.0.0.1:')
    const lines = events.since(MachineId('m1')).events.map(event => event.line)
    expect(lines.some(line => line.includes('捆绑插件同步失败'))).toBe(true)
  })

  it('stamps the tunnel with the minted session cookie once the launch token resolves', async () => {
    let mintedUrl = ''
    const { manager, transport } = boot({
      sessionFactory: () => {
        const session = new FakeSession(() => true)
        session.webTokenResult = 'tok-abc-123\n'
        return session
      },
      mintCookie: (url) => {
        mintedUrl = url
        return Promise.resolve('dsh-auth-x=v1.signed')
      },
    })
    const link = await manager.connect(MachineId('m1'))
    // mint 走隧道自身的带 token URL；注入槽随后携带 Cookie（iframe 免登录）
    expect(mintedUrl).toBe('http://127.0.0.1:49152/?token=tok-abc-123')
    expect(transport.sessions[0]?.tunnelInjection?.cookie).toBe('dsh-auth-x=v1.signed')
    expect(link.tunnelBaseUrl).toBe('http://127.0.0.1:49152/?token=tok-abc-123')
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
    expect(link.tunnelBaseUrl).toBe('http://127.0.0.1:49152')
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
