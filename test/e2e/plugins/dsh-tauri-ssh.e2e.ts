/**
 * dsh-tauri-ssh 远程机插件 E2E：真实 ssh2 传输层与真实 SSH 协议往返。
 *
 * 四条契约各占一个 describe，共用同一套 `bootHarness` 脚手架——装配真实的
 * 运行时单例（`transport` 服务 + `config/runtime.ts` 的 use* 装配面），宿主
 * 自身 `~/.ssh` 的别名与身份文件解析，带时间戳的 status/event 证据日志。
 * 事件证据走公开读面 `events.since(machineId, fromSeq)` 轮询：重构后事件类
 * 已不存在，轮询读回的每一行按 `event <stage>[/<terminal>]: <line>` 打平，
 * `at` 取事件自报的 `ts`，因此重连退避的间隔算术与轮询延迟无关。断言对象是
 * 外部世界（HTTP 字节、服务端记录的认证方法序列、被杀的 sshd 会话进程），
 * 不采信插件自报：
 * - reconnect：真实 linux x64 机器上杀掉服务端会话 → 自动重连 → 同一隧道 URL 继续服务；
 * - give-up：持续不可达的本机端口上的指数退避节奏与 given-up 终态；
 * - password-chain：回环 ssh2 协议服务器上的 agent→key→password 认证链与三类失败分类；
 * - watchdog：静默冻结（无 FIN/RST）连接上的 keepalive 看门狗。
 *
 * 环境降级标注（不得以 skip 掩盖）：
 * - password-chain：本机 22 端口关闭、无 docker、共享 dev 机 sshd 配置不可动，
 *   故无 OS sshd 可测——「OS-sshd password E2E 未验证（环境不可得）」，以本地
 *   ssh2 协议服务器替代证据；
 * - reconnect：需要可达的 `ssh dev` 别名机器。
 */

import type { Connection, Server as SshServer } from 'ssh2'
import type { MachineProfile, SshSession } from '../../../packages/dsh-tauri-ssh/src/host/types/index'
import { execSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect as tcpConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { Server } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { machineProfiles, resetRuntime, setHostConfig, setMachineDeps } from '../../../packages/dsh-tauri-ssh/src/host/config/runtime'
import { events } from '../../../packages/dsh-tauri-ssh/src/host/service/events'
import { machine } from '../../../packages/dsh-tauri-ssh/src/host/service/machine'
import { transport } from '../../../packages/dsh-tauri-ssh/src/host/service/transport'
import { MachineId } from '../../../packages/dsh-tauri-ssh/src/host/types/index'
import { EMPTY_ALLOWLIST } from '../../../packages/dsh-tauri-ssh/src/host/utils/allowlist'

/** One timestamped evidence line. */
interface EvidenceLine {
  at: number
  text: string
}

/** The E2E harness: the assembled runtime service plus captured evidence. */
interface Harness {
  manager: typeof machine
  evidence: EvidenceLine[]
  drain: () => void
  log: (text: string) => void
  dispose: () => Promise<void>
}

/** A monotonic-ish wall clock in epoch ms. */
function now(): number {
  return Date.now()
}

/** One freshly generated RSA key in PKCS#1 PEM form (what ssh2 parses natively). */
function freshRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return String(privateKey.export({ format: 'pem', type: 'pkcs1' }))
}

/** Every `it` leaves no runtime behind (assembly is process-global state). */
afterEach(() => {
  resetRuntime()
})

/**
 * Boot one real-transport runtime with scratch TOFU/state storage and the
 * given connect/reconnect timing, logging every status and event emission
 * with a timestamp.
 *
 * Assembly order is the production one (`apply.ts` is the only other caller):
 * reset the runtime → `setHostConfig` → `setMachineDeps`.
 */
function bootHarness(options: {
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectMaxAttempts?: number
  healthPollIntervalMs?: number
  healthPollAttempts?: number
  sshDir?: string
} = {}): Harness {
  const evidence: EvidenceLine[] = []
  const t0 = now()
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
  const seenSeq = new Map<MachineId, number>()

  /**
   * Read the public event surface forward from the last seen seq. `at` is the
   * event's own timestamp, so the retry spacing is exact regardless of how
   * often this poller happens to run.
   */
  const drain = (): void => {
    for (const machineId of machineProfiles.keys()) {
      const after = seenSeq.get(machineId) ?? 0
      const page = events.since(machineId, after)
      // Advance only past events actually handed over: `nextSeq` is the
      // buffer's own next seq and would skip events appended after the poll.
      const last = page.events.at(-1)?.seq
      if (last !== undefined)
        seenSeq.set(machineId, last)
      for (const event of page.events) {
        const at = Date.parse(event.ts)
        evidence.push({
          at: Number.isNaN(at) ? now() : at,
          text: `event ${event.stage}${event.terminal === undefined ? '' : `/${event.terminal}`}: ${event.line}`,
        })
      }
    }
  }

  const log = (text: string): void => {
    drain()
    const line = { at: now(), text }
    evidence.push(line)
    // eslint-disable-next-line no-console -- the E2E evidence log is the point
    console.log(`[+${(line.at - t0).toString().padStart(6)}ms] ${text}`)
  }

  resetRuntime()
  setHostConfig({
    connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    healthCheckTimeoutMs: 3_000,
    healthPollIntervalMs: options.healthPollIntervalMs ?? 500,
    healthPollAttempts: options.healthPollAttempts ?? 30,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 3_000,
    keepaliveCountMax: options.keepaliveCountMax ?? 3,
    reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 1_000,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 5_000,
    reconnectMaxAttempts: options.reconnectMaxAttempts ?? 6,
    // The host's real ~/.ssh: config aliases and identity files, exactly
    // what the plugin in the desktop app would resolve against.
    sshDir: options.sshDir ?? join(homedir(), '.ssh'),
    // Scratch TOFU + machine table: the suite must never touch ~/.dsh.
    knownHostsPath: join(root, 'known-hosts.json'),
    statePath: join(root, 'machines.json'),
  })
  setMachineDeps({
    transport,
    emitStatus: (statusId, status) => {
      const hints = [
        status.state,
        ...status.tunnelBaseUrl === undefined ? [] : [`tunnel=${status.tunnelBaseUrl}`],
        ...status.nextRetryAt === undefined ? [] : [`nextRetryAt=+${status.nextRetryAt - now()}ms`],
        ...status.authMethod === undefined ? [] : [`auth=${status.authMethod}`],
        ...status.lastError === undefined ? [] : [`lastError=${status.lastError}`],
      ]
      log(`status ${String(statusId)}: ${hints.join(' ')}`)
    },
    localAllowlist: () => ({ ...EMPTY_ALLOWLIST }),
  })
  const poller = setInterval(drain, 50)

  return {
    manager: machine,
    evidence,
    drain,
    log,
    dispose: async () => {
      clearInterval(poller)
      drain()
      await machine.dispose()
      resetRuntime()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Wait until the predicate holds or the deadline passes (step-probe wait). */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = now() + timeoutMs
  while (!predicate()) {
    if (now() > deadline)
      throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Brand a machine id. */
function id(name: string): ReturnType<typeof MachineId> {
  return MachineId(name)
}

/**
 * Whether the operator's `~/.ssh/config` declares a host alias. The drop spec
 * needs a real sshd it may kill a session on, so it can only be verified where
 * such an alias exists; the gate reads the config file itself (no network) and
 * the reason is printed, so a skipped run is never a silent one.
 */
function sshConfigDeclaresHost(host: string): boolean {
  try {
    return readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')
      .split('\n')
      .some((line) => {
        const declared = /^Host[ \t]+(\S.*)$/iu.exec(line.trim())?.[1]
        return declared !== undefined && declared.split(/\s+/u).includes(host)
      })
  }
  catch {
    return false
  }
}

/** The alias the drop spec drives (the gate for verifying it). */
const DROP_HOST_ALIAS = 'dev'

const dropHostAvailable = sshConfigDeclaresHost(DROP_HOST_ALIAS)

if (!dropHostAvailable) {
  console.warn(`[e2e] skipping the reconnect drop spec: ~/.ssh/config declares no \`${DROP_HOST_ALIAS}\` host to kill a session on`)
}

/**
 * E2E #1 — drop-driven auto-reconnect on a real linux x64 machine.
 *
 * Flow: connect to `ssh dev` (a python3 HTTP server stands in for the remote
 * `dsh web` instance — the dev host has no Node/dsh and the clone-path
 * install cannot run there; the connection/tunnel/poll surface under test is
 * identical), verify the tunnel serves HTTP, kill exactly the sshd session
 * process serving OUR connection (identified as the one new session worker
 * that appeared while connecting; never the listener, never a global
 * restart), and watch the manager walk connected → reconnecting → connected
 * with the SAME tunnel URL serving HTTP again.
 *
 * Environment gate: this spec is the only one in the suite that cannot be
 * stood in for — it kills a live sshd session, so it needs the operator's own
 * `dev` alias. Without that alias the describe is reported as skipped (with
 * the reason printed above), never silently passed; a machine that has `dev`
 * verifies the real contract.
 */
describe.skipIf(!dropHostAvailable)('e2e reconnect (linux x64 dev machine)', () => {
  const REMOTE_PORT = 3100

  const profile: MachineProfile = {
    id: id('dev-drop'),
    name: 'dev-drop',
    host: DROP_HOST_ALIAS,
    port: 22,
    user: '',
    // The remote instance stand-in: any loopback HTTP listener exercises the
    // same probe → start → healthy → tunnel path.
    startCommand: `python3 -m http.server ${REMOTE_PORT} --bind 127.0.0.1`,
    remotePort: REMOTE_PORT,
  }

  /**
   * The dev host's container hides /proc/net from `ss`, so peer-port matching
   * is unavailable. Instead: snapshot the sshd session workers (the
   * `sshd-session: …@notty` processes, excluding the probe's own session via
   * `$PPID` and the privileged parents), and diff around our connect.
   */
  function sshdSessionWorkers(): Set<number> {
    const out = execSync(
      `ssh dev 'echo OWN=$PPID; ps -eo pid=,cmd= | grep "[s]shd-session"'`,
      { encoding: 'utf8' },
    )
    const own = Number(out.match(/OWN=(\d+)/u)?.[1] ?? NaN)
    const workers = new Set<number>()
    for (const line of out.split('\n')) {
      const pid = Number(line.trim().match(/^(\d+)\s/u)?.[1] ?? NaN)
      if (!Number.isFinite(pid) || pid === own)
        continue
      if (line.includes('[priv]'))
        continue
      if (line.includes('@'))
        workers.add(pid)
    }
    return workers
  }

  it('recovers a server-side session kill with the same tunnel URL', async () => {
    const harness = bootHarness({ keepaliveIntervalMs: 3_000, reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 5_000, reconnectMaxAttempts: 6 })
    const { manager, log } = harness
    try {
      manager.refreshProfiles(new Map([[profile.id, profile]]))

      // 1. Connect and verify the tunnel serves HTTP (the "polling" probe).
      const beforeSessions = sshdSessionWorkers()
      const link = await manager.connect(profile.id)
      expect(manager.status(profile.id).state).toBe('connected')
      const afterSessions = sshdSessionWorkers()
      const fresh = [...afterSessions].filter(pid => !beforeSessions.has(pid))
      const before = await fetch(link.tunnelBaseUrl)
      expect(before.status).toBe(200)
      log(`tunnel serves HTTP ${before.status} at ${link.tunnelBaseUrl}`)
      // A second URL through the same tunnel proves a real HTTP round trip.
      const deep = await fetch(`${link.tunnelBaseUrl}/definitely-missing`)
      expect(deep.status).toBe(404)

      // 2. Our session worker is exactly the one that appeared during the
      //    connect; verify what we are about to kill before killing it.
      expect(fresh.length).toBe(1)
      const pid = fresh[0]!
      const cmdOfPid = execSync(`ssh dev "ps -p ${pid} -o cmd="`, { encoding: 'utf8' }).trim()
      expect(cmdOfPid, `refusing to kill non-sshd process: ${cmdOfPid}`).toMatch(/sshd-session/iu)
      log(`identified session sshd pid=${pid} (${cmdOfPid}) as the connect-window diff`)

      // 3. Kill exactly that process (targeted single PID, no restarts).
      execSync(`ssh dev "kill ${pid}"`)
      log(`killed session sshd pid=${pid}`)

      // 4. The manager must walk reconnecting → connected on its own.
      await waitFor(() => manager.status(profile.id).state === 'reconnecting', 'reconnecting state')
      log('observed reconnecting state')
      await waitFor(() => manager.status(profile.id).state === 'connected', 'auto-reconnect', 60_000)
      const status = manager.status(profile.id)
      expect(status.state).toBe('connected')
      expect(['agent', 'key']).toContain(status.authMethod)
      log(`auto-reconnected (auth=${status.authMethod})`)

      // 5. Same URL, serving again: tunnel rebuilt on the preferred port.
      expect(manager.link(profile.id)?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      const after = await fetch(link.tunnelBaseUrl)
      expect(after.status).toBe(200)
      log(`tunnel serves HTTP ${after.status} again at the SAME ${link.tunnelBaseUrl}`)

      // 6. Clean teardown; a manual disconnect is `disconnected`, not given-up.
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')

      // 7. Leave the dev machine as we found it: stop the stand-in listener
      //    (verify it is our python3 http.server before killing the PID).
      const listenerLine = execSync(
        `ssh dev "ss -tlnp '( sport = :${REMOTE_PORT} )' | grep ':${REMOTE_PORT} '"`,
        { encoding: 'utf8' },
      ).trim()
      const listenerPid = listenerLine.match(/pid=(\d+)/u)?.[1]
      if (listenerPid !== undefined) {
        const listenerCmd = execSync(`ssh dev "ps -p ${listenerPid} -o cmd="`, { encoding: 'utf8' }).trim()
        if (/http\.server/iu.test(listenerCmd)) {
          execSync(`ssh dev "kill ${listenerPid}"`)
          log(`stopped stand-in listener pid=${listenerPid} on remote port ${REMOTE_PORT}`)
        }
        else {
          log(`left remote listener pid=${listenerPid} alone (not our http.server: ${listenerCmd})`)
        }
      }
    }
    finally {
      await harness.dispose()
    }
  }, 240_000)
})

/**
 * E2E #2 — backoff rhythm and the give-up terminal state, driven by a
 * persistently unreachable local port (nothing listens on 127.0.0.1:1).
 * Records every event timestamp so the exponential schedule is readable in
 * the evidence log.
 */
describe('e2e give-up (local unreachable port)', () => {
  const profile: MachineProfile = {
    id: id('unreachable'),
    name: 'unreachable',
    host: '127.0.0.1',
    port: 1,
    user: 'root',
    remotePort: 3080,
  }

  it('retries on an exponential schedule, then lands in given-up', async () => {
    const harness = bootHarness({
      connectTimeoutMs: 2_000,
      reconnectInitialDelayMs: 300,
      reconnectMaxDelayMs: 1_200,
      reconnectMaxAttempts: 4,
    })
    const { manager } = harness
    try {
      manager.refreshProfiles(new Map([[profile.id, profile]]))

      // The first failure rejects the caller's connect; the loop continues.
      await expect(manager.connect(profile.id)).rejects.toThrow()
      await waitFor(() => manager.status(profile.id).state === 'given-up', 'give-up', 30_000)

      const status = manager.status(profile.id)
      expect(status.state).toBe('given-up')
      expect(status.nextRetryAt).toBeUndefined()
      expect(status.lastError).toMatch(/connect failed after 5 attempt\(s\)/u)
      expect(status.lastError).toMatch(/host unreachable/u)

      // The retry schedule from the event log: one auth failure per attempt,
      // one reconnect line per scheduled retry, gaps growing 300→600→1200→1200.
      harness.drain()
      const retryLines = harness.evidence.filter(line => line.text.includes('event reconnect: retrying'))
      const gaps: number[] = []
      let previous: number | undefined
      for (const line of retryLines) {
        if (previous !== undefined)
          gaps.push(line.at - previous)
        previous = line.at
      }
      harness.log(`retry gaps: ${gaps.join(', ')} ms`)
      expect(gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of gaps)
        expect(gap).toBeGreaterThan(0)
      // Each gap at least as long as the previous one (the schedule only
      // grows, capped at 1.2 s; small scheduling jitter tolerated).
      for (let i = 1; i < gaps.length; i++)
        expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 50)

      // A manual disconnect after give-up is a different, clean terminal.
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')
    }
    finally {
      await harness.dispose()
    }
  }, 120_000)
})

/**
 * E2E #3 — password authentication over a real SSH protocol round trip.
 *
 * Environment note: no OS sshd with password login is reachable from this
 * host (local port 22 closed, no docker, and the shared root dev machine's
 * sshd config must not be touched). The stand-in is a loopback ssh2 protocol
 * server that rejects every publickey attempt and accepts exactly one
 * password — the full agent→key→password chain, the order evidence
 * (server-recorded method sequence), and the three failure classes are all
 * exercised over the wire by the real transport.
 *
 * Downgrade label: OS-sshd password E2E 未验证（环境不可得）；本套为本地
 * ssh2 协议服务器替代证据。
 */
describe('e2e password chain (loopback ssh2 protocol server)', () => {
  const PASSWORD = 'e2e-trustno1'

  /** One server-side authentication attempt record. */
  interface AuthAttempt {
    method: string
    accepted: boolean
  }

  /** The recorded auth attempts and the accepted method, per connection. */
  const attempts: AuthAttempt[] = []
  let server: SshServer
  let serverPort = 0
  let scratchHome: string
  let scratchSshDir: string
  const envBefore: { USERPROFILE: string | undefined, HOME: string | undefined } = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }

  /**
   * A scratch identity file is fed to the host as `~/.ssh/id_rsa` of a scratch
   * HOME, not as an absolute path: `resolveSshAuth` treats every identity path
   * that does not literally start with `/` as home-relative
   * (`host/utils/ssh-config.ts:37-41`), so a Windows drive path such as
   * `C:/…/.ssh/id_rsa` is joined onto the home dir twice and resolves to no
   * key at all. Going through the home-relative branch keeps the production
   * path (config discovery → identity files → transport auth order) real on
   * every platform; the absolute-path defect is the package's own problem
   * (`utils/ssh-config.test.ts` is red on Windows for exactly that reason).
   */
  beforeAll(async () => {
    // A fresh host key pair for the server and one for the client's (rejected)
    // identity file.
    const hostKey = freshRsaPem()
    const clientKey = freshRsaPem()
    scratchHome = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-home-'))
    scratchSshDir = join(scratchHome, '.ssh')
    mkdirSync(scratchSshDir, { recursive: true })
    writeFileSync(join(scratchSshDir, 'id_rsa'), clientKey)
    // `homeDir()` is read when the runtime is assembled, so it must already
    // point at the scratch home before the first `bootHarness` in each `it`.
    process.env.USERPROFILE = scratchHome
    process.env.HOME = scratchHome

    server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD) {
          attempts.push({ method: ctx.method, accepted: true })
          ctx.accept()
          return
        }
        attempts.push({ method: ctx.method, accepted: false })
        ctx.reject(['publickey', 'password'])
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec) => {
          const stream = acceptExec()
          stream.write('Linux x86_64\n')
          stream.exit(0)
          stream.end()
        })
      })
      client.on('error', () => {
        // Client-side hangups during failure cases surface here; expected.
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    serverPort = (server.address() as { port: number }).port
  })

  afterAll(() => {
    server.close()
    rmSync(scratchHome, { recursive: true, force: true })
    if (envBefore.USERPROFILE === undefined)
      delete process.env.USERPROFILE
    else process.env.USERPROFILE = envBefore.USERPROFILE
    if (envBefore.HOME === undefined)
      delete process.env.HOME
    else process.env.HOME = envBefore.HOME
  })

  function profileWith(password?: string): MachineProfile {
    return {
      id: id('password-e2e'),
      name: 'password-e2e',
      host: '127.0.0.1',
      port: serverPort,
      user: 'root',
      ...password === undefined ? {} : { password },
      remotePort: 3080,
    }
  }

  it('authenticates with the stored password after agent and keys are refused', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith(PASSWORD)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result).toEqual({ ok: true, banner: 'Linux x86_64' })

      // Order evidence: every publickey attempt (agent-sourced and the
      // identity file) precedes the accepted password attempt.
      const methods = attempts.map(attempt => attempt.method)
      harness.log(`server saw auth methods: ${methods.join(' -> ')}`)
      expect(methods[methods.length - 1]).toBe('password')
      expect(attempts.at(-1)?.accepted).toBe(true)
      const passwordIndex = methods.indexOf('password')
      expect(methods.slice(0, passwordIndex).every(method => method === 'publickey')).toBe(true)
      expect(passwordIndex).toBeGreaterThan(0)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies a wrong stored password as password-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith('wrong-password')
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/stored password was rejected/u)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies exhausted keys without a password as key-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith()
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/no key or ssh-agent was accepted/u)
    }
    finally {
      await harness.dispose()
    }
  })
})

/**
 * E2E #4 — the keepalive watchdog on a hung (silent) connection. A local
 * proxy stops forwarding bytes in both directions (no FIN, no RST — exactly
 * what a NAT/firewall drop looks like); ssh2's keepalive misses its
 * heartbeat budget and must declare the session closed, surfacing through
 * the session's onClosed callback (the manager's reconnect trigger).
 *
 * The session comes from `machine.openSession`, i.e. the keepalive budget is
 * the assembled Config's, not a hand-built transport's.
 */
describe('e2e keepalive watchdog (silent connection freeze)', () => {
  const PASSWORD = 'e2e-watchdog'
  const KEEPALIVE_INTERVAL_MS = 1_000
  const KEEPALIVE_COUNT_MAX = 3

  let server: SshServer
  let serverPort = 0
  let scratchSshDir: string

  /** The stalling proxy: pipes traffic until `freeze()` silently drops it. */
  function startStallingProxy(): Promise<{ port: number, freeze: () => void, close: () => void }> {
    const sockets = new Set<{ a: import('node:net').Socket, b: import('node:net').Socket }>()
    const proxy = createServer((downstream) => {
      const upstream = tcpConnect(serverPort, '127.0.0.1')
      const pair = { a: downstream, b: upstream }
      sockets.add(pair)
      downstream.on('close', () => sockets.delete(pair))
      upstream.on('close', () => sockets.delete(pair))
      downstream.pipe(upstream)
      upstream.pipe(downstream)
      downstream.on('error', () => downstream.destroy())
      upstream.on('error', () => upstream.destroy())
    })
    return new Promise((resolve) => {
      proxy.listen(0, '127.0.0.1', () => {
        resolve({
          port: (proxy.address() as { port: number }).port,
          freeze: (): void => {
            // Stop forwarding in both directions without closing anything: the
            // client sees a silent, still-open TCP connection.
            for (const { a, b } of sockets) {
              a.unpipe(b)
              b.unpipe(a)
              a.pause()
              b.pause()
            }
          },
          close: (): void => {
            for (const { a, b } of sockets) {
              a.destroy()
              b.destroy()
            }
            proxy.close()
          },
        })
      })
    })
  }

  beforeAll(async () => {
    server = new Server({ hostKeys: [freshRsaPem()] }, (client: Connection) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD)
          ctx.accept()
        else
          ctx.reject(['password'])
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec) => {
          const stream = acceptExec()
          stream.write('Linux x86_64\n')
          stream.exit(0)
          stream.end()
        })
      })
      client.on('error', () => {
        // Watchdog teardowns land here on the server side; expected.
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    serverPort = (server.address() as { port: number }).port
    scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-watchdog-'))
    writeFileSync(join(scratchSshDir, 'config'), '')
  })

  afterAll(() => {
    server.close()
    rmSync(scratchSshDir, { recursive: true, force: true })
  })

  it('declares a hung session closed after the heartbeat budget', async () => {
    const proxy = await startStallingProxy()
    const profile: MachineProfile = {
      id: MachineId('watchdog'),
      name: 'watchdog',
      host: '127.0.0.1',
      port: proxy.port,
      user: 'root',
      password: PASSWORD,
      remotePort: 3080,
    }
    const harness = bootHarness({
      connectTimeoutMs: 5_000,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      sshDir: scratchSshDir,
    })
    let session: SshSession | undefined
    try {
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const opened = await harness.manager.openSession(profile.id)
      session = opened
      expect(opened.authMethod).toBe('password')

      const closedAt = new Promise<number>((resolve) => {
        opened.onClosed(() => resolve(Date.now()))
      })
      const frozeAt = Date.now()
      proxy.freeze()

      // ssh2 must give up after ~interval*(countMax) of unanswered
      // heartbeats and surface the close — not hang forever on the silent
      // socket. Assert a generous upper bound so the test stays robust.
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('watchdog never declared the session closed')), 30_000)
      })
      const closed = await Promise.race([closedAt, timeout])
      const elapsed = closed - frozeAt
      // eslint-disable-next-line no-console -- evidence log
      console.log(`[watchdog] silent freeze → close after ${elapsed} ms (interval ${KEEPALIVE_INTERVAL_MS} ms × ${KEEPALIVE_COUNT_MAX} missed)`)
      expect(elapsed).toBeGreaterThan(KEEPALIVE_INTERVAL_MS * KEEPALIVE_COUNT_MAX - 500)
      expect(elapsed).toBeLessThan(20_000)
    }
    finally {
      await session?.close().catch(() => undefined)
      proxy.close()
      await harness.dispose()
    }
  }, 60_000)
})
