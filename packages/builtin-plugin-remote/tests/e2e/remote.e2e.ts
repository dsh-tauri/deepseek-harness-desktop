import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Browser } from 'playwright'
import type { Connection, Server as SshServer } from 'ssh2'
import type { DshPage } from '../../../../apps/desktop/tests/e2e/support/browser'
import type { MachineProfile, RemoteHostContext, RemoteSession } from '../../src/host/types/index'
import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { Server } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { launchDshBrowser, newDshPage, openSettings, selectSettingsSection } from '../../../../apps/desktop/tests/e2e/support/browser'
import { clearHostRuntime, machineProfiles, setCurrentHostInstance, setHostConfig, setMachineDeps } from '../../src/host/config/runtime'
import { events } from '../../src/host/service/events'
import { machine } from '../../src/host/service/machine'
import { sshTransport } from '../../src/host/service/transport.ssh'
import { MachineId } from '../../src/host/types/index'
import { EMPTY_ALLOWLIST } from '../../src/host/utils/allowlist'
import { RECOMMENDED_DSH_VERSION } from '../../src/host/utils/version'

interface EvidenceLine {
  at: number
  text: string
}

interface Harness {
  manager: typeof machine
  evidence: EvidenceLine[]
  drain: () => void
  log: (text: string) => void
  dispose: () => Promise<void>
}

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
  const t0 = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
  const seenSeq = new Map<MachineId, number>()
  const drain = (): void => {
    for (const machineId of machineProfiles.keys()) {
      const page = events.since(machineId, seenSeq.get(machineId) ?? 0)
      const last = page.events.at(-1)?.seq
      if (last !== undefined)
        seenSeq.set(machineId, last)
      for (const event of page.events) {
        const at = Date.parse(event.ts)
        evidence.push({
          at: Number.isNaN(at) ? Date.now() : at,
          text: `event ${event.stage}${event.terminal === undefined ? '' : `/${event.terminal}`}: ${event.line}`,
        })
      }
    }
  }
  const log = (text: string): void => {
    drain()
    const line = { at: Date.now(), text }
    evidence.push(line)
    process.stderr.write(`[ssh-e2e +${line.at - t0}ms] ${text}\n`)
  }
  const context: RemoteHostContext = {
    webServer: { register: () => () => {} },
    effect: () => undefined,
  }
  clearHostRuntime()
  setCurrentHostInstance(context)
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
    sshDir: options.sshDir ?? join(root, 'ssh'),
    knownHostsPath: join(root, 'known-hosts.json'),
    statePath: join(root, 'machines.json'),
  })
  setMachineDeps({
    transport: { resolve: () => sshTransport },
    emitStatus: (statusId, status) => {
      const hints = [
        status.state,
        ...status.tunnelBaseUrl === undefined ? [] : [`tunnel=${status.tunnelBaseUrl}`],
        ...status.nextRetryAt === undefined ? [] : [`nextRetryAt=+${status.nextRetryAt - Date.now()}ms`],
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
      try {
        await machine.dispose()
      }
      finally {
        clearHostRuntime()
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function freshRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return String(privateKey.export({ format: 'pem', type: 'pkcs1' }))
}

afterEach(() => {
  clearHostRuntime()
})
function id(name: string): ReturnType<typeof MachineId> {
  return MachineId(name)
}
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
      await expect(manager.connect(profile.id)).rejects.toThrow()
      await waitFor(() => manager.status(profile.id).state === 'given-up', 'give-up', 30_000)

      const status = manager.status(profile.id)
      expect(status.state).toBe('given-up')
      expect(status.nextRetryAt).toBeUndefined()
      expect(status.lastError).toMatch(/connect failed after 5 attempt\(s\)/u)
      expect(status.lastError).toMatch(/host unreachable/u)
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
      for (let i = 1; i < gaps.length; i++)
        expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 50)
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')
    }
    finally {
      await harness.dispose()
    }
  }, 120_000)
})
describe('e2e password chain (loopback ssh2 protocol server)', () => {
  const PASSWORD = 'e2e-trustno1'
  interface AuthAttempt {
    method: string
    accepted: boolean
  }
  const attempts: AuthAttempt[] = []
  let server: SshServer
  let serverPort = 0
  let scratchHome: string
  let scratchSshDir: string
  const envBefore: { USERPROFILE: string | undefined, HOME: string | undefined } = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }
  beforeAll(async () => {
    const hostKey = freshRsaPem()
    const clientKey = freshRsaPem()
    scratchHome = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-home-'))
    scratchSshDir = join(scratchHome, '.ssh')
    mkdirSync(scratchSshDir, { recursive: true })
    writeFileSync(join(scratchSshDir, 'id_rsa'), clientKey)
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
describe('e2e keepalive watchdog (silent connection freeze)', () => {
  const PASSWORD = 'e2e-watchdog'
  const KEEPALIVE_INTERVAL_MS = 1_000
  const KEEPALIVE_COUNT_MAX = 3

  let server: SshServer
  let serverPort = 0
  let scratchSshDir: string
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
    let session: RemoteSession | undefined
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
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('watchdog never declared the session closed')), 30_000)
      })
      const closed = await Promise.race([closedAt, timeout])
      const elapsed = closed - frozeAt
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
describe('e2e outbound gateway (loopback ssh2 protocol server)', () => {
  const PASSWORD = 'e2e-outbound'
  const TOKEN = 'tok-e2e-outbound'
  const BULK_BYTES = 200 * 1024
  const BULK = Buffer.alloc(BULK_BYTES, 0x41)
  const BOOT_HTML = '<html><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>'

  interface RemoteRequest {
    url: string
    host: string | undefined
    encoding: string | undefined
    cookie: string | undefined
  }

  interface Upstream {
    port: number
    requests: RemoteRequest[]
    close: () => Promise<void>
  }

  interface SshdState {
    negotiated: string | undefined
    commands: string[]
  }

  interface Sshd {
    server: SshServer
    port: number
    state: SshdState
  }

  let sshd: Sshd
  let plainSshd: Sshd
  let sshdProxy: { port: number, close: () => void }
  let plainProxy: { port: number, close: () => void }
  let wireBytes = 0
  let scratchSshDir = ''
  async function startUpstream(port = 0): Promise<Upstream> {
    const requests: RemoteRequest[] = []
    const upgraded = new Set<Duplex>()
    const server = createHttpServer((request, response) => {
      const url = request.url ?? ''
      requests.push({
        url,
        host: request.headers.host,
        encoding: request.headers['accept-encoding'],
        cookie: request.headers.cookie,
      })
      if (url.startsWith('/?token=')) {
        if (url !== `/?token=${TOKEN}`) {
          response.statusCode = 401
          response.end('bad token')
          return
        }
        response.setHeader('set-cookie', [`dsh-session=${TOKEN}; Path=/; HttpOnly`])
        response.end('minted')
        return
      }
      if (request.headers.cookie !== `dsh-session=${TOKEN}`) {
        response.statusCode = 401
        response.end('unauthorized')
        return
      }
      if (url === '/bulk') {
        response.setHeader('content-type', 'application/javascript')
        response.end(BULK)
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end('dsh-ok')
    })
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve())
    })
    server.on('upgrade', (request, socket) => {
      upgraded.add(socket)
      socket.on('close', () => upgraded.delete(socket))
      requests.push({
        url: request.url ?? '',
        host: request.headers.host,
        encoding: request.headers['accept-encoding'],
        cookie: request.headers.cookie,
      })
      acceptWebSocket(request, socket)
    })
    return {
      port: (server.address() as { port: number }).port,
      requests,
      close: async () => {
        for (const socket of upgraded)
          socket.destroy()
        upgraded.clear()
        server.closeAllConnections()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      },
    }
  }
  function acceptWebSocket(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key']
    if (request.headers.cookie !== `dsh-session=${TOKEN}` || typeof key !== 'string') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    echoFrames(socket)
  }
  function echoFrames(socket: Duplex): void {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0F
        const masked = (pending[1]! & 0x80) !== 0
        let length = pending[1]! & 0x7F
        let offset = 2
        if (length === 126) {
          if (pending.length < 4)
            return
          length = pending.readUInt16BE(2)
          offset = 4
        }
        const maskLength = masked ? 4 : 0
        if (pending.length < offset + maskLength + length)
          return
        const mask = masked ? pending.subarray(offset, offset + 4) : undefined
        const payload = Buffer.from(pending.subarray(offset + maskLength, offset + maskLength + length))
        if (mask !== undefined) {
          for (let index = 0; index < payload.length; index++)
            payload[index] = payload[index]! ^ mask[index % 4]!
        }
        pending = pending.subarray(offset + maskLength + length)
        if (opcode === 0x8) {
          socket.write(Buffer.from([0x88, 0x00]))
          socket.end()
          return
        }
        if (opcode === 0x1 || opcode === 0x2)
          socket.write(frameOf(opcode, payload))
      }
    })
  }

  function frameOf(opcode: number, payload: Buffer): Buffer {
    if (payload.length < 126)
      return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
    const extended = Buffer.alloc(2)
    extended.writeUInt16BE(payload.length)
    return Buffer.concat([Buffer.from([0x80 | opcode, 126]), extended, payload])
  }

  function echoOnce(socket: WebSocket, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('e2e: WebSocket 回显超时')), 15_000)
      socket.addEventListener('open', () => socket.send(text))
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
        socket.close()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('e2e: WebSocket 升级失败'))
      })
    })
  }
  async function startSshd(compressAlgorithms?: ['none']): Promise<Sshd> {
    const state: SshdState = { negotiated: undefined, commands: [] }
    const server = new Server(
      {
        hostKeys: [freshRsaPem()],
        ...compressAlgorithms === undefined ? {} : { algorithms: { compress: compressAlgorithms } },
      },
      (client: Connection) => {
        client.on('authentication', (ctx) => {
          if (ctx.method === 'password' && ctx.password === PASSWORD) {
            ctx.accept()
            return
          }
          ctx.reject(['publickey', 'password'])
        })
        client.on('ready', () => {
          const kex = (client as unknown as {
            _protocol?: { _kex?: { negotiated?: { cs?: { compress?: string } } } }
          })._protocol?._kex
          state.negotiated = kex?.negotiated?.cs?.compress
        })
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec()
            const command = (info as { command?: string }).command ?? ''
            state.commands.push(command)
            if (command.includes('grep -oE') && command.includes('token=')) {
              stream.write(`${TOKEN}\n`)
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('REMOTE_DSH_LISTENER_PACKAGE')) {
              stream.write(JSON.stringify({ name: '@deepseek-ai/dsh', version: RECOMMENDED_DSH_VERSION }))
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('REMOTE_DSH_LISTENER_PID')) {
              stream.write([
                'Linux',
                '4242',
                '/opt/remote-dsh',
                '1760000000:987654',
                '/usr/bin/node\0/opt/remote-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js\0',
              ].join('\n'))
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('%{http_code}')) {
              stream.write('console.log(1)\n200')
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('curl -s -m')) {
              stream.write(BOOT_HTML)
              stream.exit(0)
              stream.end()
              return
            }
            stream.stderr.write('e2e: 未实现的远端命令\n')
            stream.exit(1)
            stream.end()
          })
        })
        client.on('tcpip', (accept, _reject, info) => {
          const channel = accept()
          const dest = tcpConnect((info as { destPort: number }).destPort, '127.0.0.1')
          channel.pipe(dest).pipe(channel)
          channel.on('close', () => dest.destroy())
          dest.on('error', () => channel.close())
        })
        client.on('error', () => {
        })
      },
    )
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return { server, port: (server.address() as { port: number }).port, state }
  }
  function startProxy(target: number): Promise<{ port: number, close: () => void }> {
    const proxy = createServer((down) => {
      const up = tcpConnect(target, '127.0.0.1')
      down.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length
      })
      up.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length
      })
      down.pipe(up).pipe(down)
      down.on('error', () => down.destroy())
      up.on('error', () => up.destroy())
    })
    return new Promise((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve({
        port: (proxy.address() as { port: number }).port,
        close: () => proxy.close(),
      }))
    })
  }

  function profileFor(port: number, remotePort: number): MachineProfile {
    return {
      id: id('outbound-gateway'),
      name: 'outbound-gateway',
      host: '127.0.0.1',
      port,
      user: 'root',
      password: PASSWORD,
      remotePort,
    }
  }

  beforeAll(async () => {
    sshd = await startSshd()
    plainSshd = await startSshd(['none'])
    sshdProxy = await startProxy(sshd.port)
    plainProxy = await startProxy(plainSshd.port)
    scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-gateway-'))
    writeFileSync(join(scratchSshDir, 'config'), '')
  })

  afterAll(() => {
    sshd.server.close()
    plainSshd.server.close()
    sshdProxy.close()
    plainProxy.close()
    rmSync(scratchSshDir, { recursive: true, force: true })
  })

  it('publishes a credential-free loopback link and proxies a real request through the gateway', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(link.tunnelBaseUrl, `link 必须是无凭据的回环入口，实际 ${link.tunnelBaseUrl}`).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(link.tunnelBaseUrl).not.toContain('token')
      expect(harness.manager.status(profile.id).state).toBe('connected')
      harness.log(`connected link=${link.tunnelBaseUrl}`)

      const response = await fetch(link.tunnelBaseUrl)
      const gatewayPort = new URL(link.tunnelBaseUrl).port
      harness.log(`remote instance saw ${JSON.stringify(upstream.requests)}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('dsh-ok')
      expect(upstream.requests.map(record => record.url)).toEqual([`/?token=${TOKEN}`, '/'])
      expect(upstream.requests[1]?.cookie).toBe(`dsh-session=${TOKEN}`)
      expect(upstream.requests[1]?.host).toBe(`127.0.0.1:${gatewayPort}`)
      expect(upstream.requests[1]?.encoding).toBe('identity')
      expect(upstream.requests[1]?.url).toBe('/')
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('negotiates zlib@openssh.com and shrinks the tunnel bytes for a compressible body', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      sshd.state.negotiated = undefined
      plainSshd.state.negotiated = undefined
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(sshd.state.negotiated).toBe('zlib@openssh.com')
      harness.log(`sshd negotiated compress=${String(sshd.state.negotiated)}`)

      wireBytes = 0
      const response = await fetch(`${link.tunnelBaseUrl}/bulk`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body.length).toBe(BULK_BYTES)
      harness.log(`wire ${wireBytes} bytes for a ${BULK_BYTES}-byte body`)
      expect(wireBytes).toBeLessThan(BULK_BYTES / 5)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('degrades silently to no compression when the server does not offer it', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      plainSshd.state.negotiated = undefined
      const profile = profileFor(plainProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(plainSshd.state.negotiated).toBe('none')
      harness.log(`sshd negotiated compress=${String(plainSshd.state.negotiated)}`)

      wireBytes = 0
      const response = await fetch(`${link.tunnelBaseUrl}/bulk`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body.length).toBe(BULK_BYTES)
      harness.log(`wire ${wireBytes} bytes for a ${BULK_BYTES}-byte body without link compression`)
      expect(wireBytes).toBeGreaterThan(BULK_BYTES)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('reuses the gateway port across a disconnect so the link survives a reconnect', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const first = await harness.manager.connect(profile.id)
      await harness.manager.disconnect(profile.id)
      expect(harness.manager.status(profile.id).state).toBe('disconnected')
      const again = await harness.manager.connect(profile.id)
      expect(again.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
      harness.log(`rebound the same gateway port ${again.tunnelBaseUrl}`)
      expect((await fetch(again.tunnelBaseUrl)).status).toBe(200)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('keeps the link and the SSH session when the remote instance dies, and serves it again once the instance is back', async () => {
    const upstream = await startUpstream()
    const port = upstream.port
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000, reconnectInitialDelayMs: 300, reconnectMaxAttempts: 4 })
    let live = upstream
    try {
      const profile = profileFor(sshdProxy.port, port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect((await fetch(link.tunnelBaseUrl)).status).toBe(200)
      await live.close()
      const response = await fetch(link.tunnelBaseUrl)
      expect(response.status).toBe(502)
      await waitFor(() => (harness.manager.status(profile.id).lastError ?? '').includes('上游不可达'), 'readable per-request failure')
      expect(harness.manager.status(profile.id).state).toBe('connected')
      harness.log(`observed a per-request failure while still connected: ${harness.manager.status(profile.id).lastError}`)

      live = await startUpstream(port)
      const deadline = Date.now() + 30_000
      let resumed = await fetch(link.tunnelBaseUrl)
      while (resumed.status !== 200 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        resumed = await fetch(link.tunnelBaseUrl)
      }
      expect(resumed.status).toBe(200)
      expect(harness.manager.status(profile.id).state).toBe('connected')
      expect(harness.manager.link(profile.id)?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      harness.log(`link serves again at the SAME ${link.tunnelBaseUrl} without a reconnect`)
    }
    finally {
      await live.close()
      await harness.dispose()
    }
  }, 120_000)

  it('carries a WebSocket upgrade end to end through the outbound gateway', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      const gatewayPort = new URL(link.tunnelBaseUrl).port
      const echoUrl = `${link.tunnelBaseUrl.replace(/^http/u, 'ws')}/api/remote.mux`
      const echoed = await echoOnce(new WebSocket(echoUrl), 'ping-through-tunnel')
      expect(echoed).toBe('ping-through-tunnel')

      const upgrade = upstream.requests.find(record => record.url === '/api/remote.mux')
      expect(upgrade, '远端替身必须收到升级请求').toBeDefined()
      expect(upgrade?.cookie, '升级请求同样由网关注入铸造出的会话 cookie').toBe(`dsh-session=${TOKEN}`)
      expect(upgrade?.host).toBe(`127.0.0.1:${gatewayPort}`)
      harness.log(`upgraded through ${link.tunnelBaseUrl} and echoed a frame`)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)
})

describe('入站访问路由与面板', () => {
  const BASE = '/api/tauri/remote'
  const ACCESS = `${BASE}/access`
  const TUNNEL = `${ACCESS}/tunnel`

  interface AccessStatus {
    enabled: boolean
    state: string
    listening: boolean
    listen: { address: string, port: number }
    port: number
    auth: { enabled: boolean, scope: string, hasToken?: boolean }
    link?: string
    maskLink?: string
    qr?: string
    linkSource?: string
    pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string }
    tunnel: { enabled: boolean, mode: string, state: string, url?: string, qr?: string, progress?: { stage: string, received?: number, total?: number } }
    localPort?: number
    error?: string
    events: Array<{ seq: number, line: string }>
  }

  function url(path: string): string {
    return `${inject('dshBaseUrl')}${path}`
  }

  function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'cookie': inject('dshCookie'), 'content-type': 'application/json', ...extra }
  }

  async function readAccess(): Promise<AccessStatus> {
    const response = await fetch(url(ACCESS), { headers: apiHeaders() })
    expect(response.status, 'GET /access 必须存在且返回 200').toBe(200)
    return await response.json() as AccessStatus
  }

  async function writeAccess(body: Record<string, unknown>, method = 'POST'): Promise<{ status: number, body: AccessStatus }> {
    const response = await fetch(url(ACCESS), { method, headers: apiHeaders(), body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as AccessStatus }
  }

  function freePort(): Promise<number> {
    const server: HttpServer = createHttpServer()
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number }
        server.close(() => resolve(address.port))
      })
    })
  }

  async function disable(): Promise<AccessStatus> {
    const response = await writeAccess({ enabled: false })
    return response.body
  }

  afterEach(async () => {
    await writeAccess({ enabled: false, authEnabled: false, address: '127.0.0.1' })
  })

  describe('入站暴露路由（真实 dsh 宿主）', () => {
    it('开启回环监听：真实端口可转发，localPort 取自宿主 webserver 的实监听端口', async () => {
      const port = await freePort()
      const started = await writeAccess({ enabled: true, address: '127.0.0.1', port })
      expect(started.status).toBe(200)
      expect(started.body.listening).toBe(true)
      expect(started.body.port).toBe(port)
      expect(started.body.localPort, '非桌面载体没有 DSH_WEB_PORT，端口必须来自宿主 webserver').toBeGreaterThan(0)
      expect(started.body.link).toBe(`http://127.0.0.1:${port}/`)
      expect(started.body.linkSource).toBe('loopback')
      expect(started.body.qr, '面板需要本地核对用二维码，回环监听也生成').toMatch(/^data:image\/png;base64,/u)
      expect(started.body.auth.enabled, '开启暴露即自动带认证').toBe(true)
      expect(started.body.pairing?.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
      expect(started.body.auth).not.toHaveProperty('hasPassword')
      expect(started.body).not.toHaveProperty('generatedPassword')

      const proxied = await fetch(`http://127.0.0.1:${port}/`)
      expect(proxied.status).toBe(200)
      expect(await proxied.text()).toContain('<')

      const stopped = await disable()
      expect(stopped.listening).toBe(false)
      expect(stopped.link).toBeUndefined()
    }, 60_000)

    it('配对码换会话后立即轮换，旧码不可重放且既有会话仍可访问', async () => {
      const port = await freePort()
      const started = await writeAccess({ enabled: true, address: '0.0.0.0', port, authEnabled: true, scope: 'all' })
      expect(started.status).toBe(200)
      const pairing = started.body.pairing
      expect(pairing?.link).toContain(`?auth=${pairing?.code}`)
      expect(pairing?.qr).toMatch(/^data:image\/png;base64,/u)
      const origin = `http://127.0.0.1:${started.body.port}`
      const source = { 'x-dsh-remote-source': 'public', 'accept': 'application/json' }
      const challenge = await fetch(`${origin}/`, { headers: { ...source, accept: 'text/html' } })
      expect(challenge.status).toBe(401)
      const html = await challenge.text()
      expect(html).toContain('<form id="loginForm" method="post">')
      expect(html).toContain('name="code"')
      expect(html).not.toContain('name="password"')
      const exchanged = await fetch(`${origin}/?auth=${pairing?.code}`, { headers: source, redirect: 'manual' })
      expect(exchanged.status).toBe(302)
      expect(exchanged.headers.get('location')).toBe('/')
      const cookie = exchanged.headers.getSetCookie().map(value => value.split(';')[0] ?? '').find(value => value.startsWith('dsh_remote_session='))
      expect(cookie).toBeTruthy()
      const next = await readAccess()
      expect(next.pairing?.usedSeq).toBe((pairing?.usedSeq ?? 0) + 1)
      expect(next.pairing?.code).not.toBe(pairing?.code)
      expect((await fetch(`${origin}/?auth=${pairing?.code}`, { headers: source, redirect: 'manual' })).status).toBe(401)
      expect((await fetch(`${origin}/`, { headers: { ...source, cookie: cookie ?? '' } })).status).toBe(200)
    }, 60_000)

    it('原生健康检查无需会话，只有 manifest 可匿名读取且不消费配对码', async () => {
      const port = await freePort()
      const started = await writeAccess({ enabled: true, address: '127.0.0.1', port, authEnabled: true, scope: 'all' })
      expect(started.status).toBe(200)
      const origin = `http://127.0.0.1:${port}`
      const headers = { 'x-dsh-remote-source': 'public', 'accept': 'application/json' }
      const manifest = await fetch(`${origin}/manifest.webmanifest`, { headers })
      expect(manifest.status).toBe(200)
      expect(await manifest.json()).toMatchObject({ name: 'DeepSeek Harness', short_name: 'DSH' })
      expect(manifest.headers.get('set-cookie')).toBeNull()
      const head = await fetch(`${origin}/manifest.webmanifest?auth=${started.body.pairing?.code}`, { method: 'HEAD', headers })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await readAccess()).pairing).toEqual(started.body.pairing)
      expect((await fetch(`${origin}/`, { headers })).status).toBe(401)
      expect((await fetch(`${origin}${ACCESS}`, { headers })).status).toBe(401)
      expect((await fetch(`${origin}/manifest.webmanifest`, { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403)
    })

    it('隧道参数校验：具名模式缺凭据或主机名时 400，且不落盘', async () => {
      const missingCredential = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token' }) })
      expect(missingCredential.status).toBe(400)
      expect(JSON.stringify(await missingCredential.json())).toContain('Tunnel Token')

      const missingHostname = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token', token: 'cf-token' }) })
      expect(missingHostname.status).toBe(400)
      expect(JSON.stringify(await missingHostname.json())).toContain('公开主机名')

      const documentPath = join(inject('dshHome'), 'remote', 'access.json')
      const document = JSON.parse(existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : '{}') as { tunnel?: { enabled?: boolean } }
      expect(document.tunnel?.enabled ?? false).toBe(false)
      expect((await readAccess()).tunnel.state).toBe('stopped')
    }, 60_000)

    it('管理接口拒绝非回环来源（网关标识声明为公网）', async () => {
      const response = await fetch(url(ACCESS), {
        method: 'POST',
        headers: apiHeaders({ 'x-dsh-remote-source': 'public' }),
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(403)
    }, 60_000)
  })

  const ARTIFACTS = join(import.meta.dirname, '..', '.artifacts')
  const ACCESS_API = '/api/tauri/remote/access'
  const PANEL = '[data-testid="access-section"]'
  const LAN = '局域网'
  const ACCESS_TOGGLE = '[data-testid="access-toggle"]'
  const LAN_ADDRESS = '[data-testid="access-lan-address"]'
  const LAN_DRAFT = '[data-testid="access-lan-draft"]'
  const PAIRING = '[data-testid="access-pairing"]'
  const PAIRING_CODE = '[data-testid="access-pairing-code"]'
  const PAIRING_COUNTDOWN = '[data-testid="access-pairing-countdown"]'
  const PERMANENT = '[data-testid="access-permanent"]'
  const PERMANENT_VALUE = '[data-testid="access-permanent-value"]'
  const PERMANENT_REVEAL = '[data-testid="access-permanent-reveal"]'
  const TOKEN_ROTATE = '[data-testid="access-token-rotate"]'
  const TOKEN_REVOKE = '[data-testid="access-token-revoke"]'
  const REMOVED = [
    '[data-testid^="access-logs"]',
    '[data-testid="access-events"]',
    '[data-testid="access-tunnel-events"]',
    '[data-testid="access-auth-toggle"]',
    '[data-testid="access-auth-scope"]',
    '[data-testid^="access-generated-password"]',
    '[data-testid="access-link"]',
    '[data-testid="access-mask-link"]',
    '[data-testid="access-link-hint"]',
    '[data-testid="access-pairing-qr"]',
    '[data-testid="access-permanent-state"]',
    '[data-testid="access-tunnel-url"]',
    '[data-testid="access-tunnel-ready"]',
    '[data-testid="access-tunnel-code"]',
    '[data-testid="access-tunnel-qr"]',
  ].join(', ')
  const CODE = /^[2-9A-HJ-NP-Z]{8}$/u
  const MASK = '••••••••'

  interface AccessStatusPayload {
    enabled: boolean
    listen: { address: string, port: number }
    link?: string
    maskLink?: string
    linkSource?: string
    auth: { enabled: boolean, token?: string }
    pairing?: { code: string, expiresAt: number, link?: string, tunnelLink?: string }
    tunnel: { enabled: boolean, mode: string, state: string, url?: string }
  }

  let browser: Browser

  beforeAll(async () => {
    browser = await launchDshBrowser()
    mkdirSync(ARTIFACTS, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  function panelHeaders(): Record<string, string> {
    return { 'cookie': inject('dshCookie'), 'content-type': 'application/json' }
  }

  async function apiPost(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'POST', headers: panelHeaders(), body: JSON.stringify(body) })
    expect(response.status, `${path} 必须返回 200`).toBe(200)
  }

  async function apiDelete(path: string): Promise<void> {
    const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'DELETE', headers: panelHeaders() })
    expect(response.status, `${path} 必须返回 200`).toBe(200)
  }
  async function accessStatus(): Promise<AccessStatusPayload> {
    const response = await fetch(`${inject('dshBaseUrl')}${ACCESS_API}`, { headers: panelHeaders() })
    expect(response.status, `${ACCESS_API} 必须返回 200`).toBe(200)
    return await response.json() as AccessStatusPayload
  }

  function authParamOf(link: string | undefined): string | undefined {
    if (link === undefined)
      return undefined
    return new URL(link).searchParams.get('auth') ?? undefined
  }

  async function shoot(app: DshPage, name: string): Promise<void> {
    await app.page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
  }

  function switchOf(app: DshPage, name: string) {
    return app.frame.getByRole('switch', { name }).first()
  }

  async function openAccessPanel(app: DshPage): Promise<void> {
    await openSettings(app.page, app.frame, app.syntheticFallbacks)
    await selectSettingsSection(app.page, app.frame, '远程访问', app.syntheticFallbacks)
    const tab = app.frame.getByTestId('remote-tabs').getByRole('tab', { name: '远程访问' })
    await tab.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(async () => {
      if (await tab.getAttribute('aria-selected') === 'true')
        return 'true'
      await tab.click({ timeout: 5_000 }).catch(() => undefined)
      return await tab.getAttribute('aria-selected')
    }, { timeout: 60_000 }).toBe('true')
    await app.frame.locator(PANEL).waitFor({ state: 'attached', timeout: 20_000 })
  }

  async function readText(app: DshPage, selector: string): Promise<string> {
    return await app.frame.locator(selector).first().textContent() ?? ''
  }
  async function removedCount(app: DshPage): Promise<number> {
    return await app.frame.locator(PANEL).first().evaluate((panel, selector) => panel.querySelectorAll(selector).length, REMOVED)
  }
  async function resetExposure(): Promise<void> {
    await apiPost(ACCESS_API, { enabled: false, address: '127.0.0.1', authEnabled: false, password: null })
    await apiDelete(`${ACCESS_API}/tunnel`)
    await apiDelete(`${ACCESS_API}/token`)
  }

  describe('入站访问面板（真实浏览器）', () => {
    it('只渲染可配置项与凭据：无链接/二维码/日志/认证开关，配对码与宿主链接一致', async () => {
      await resetExposure()
      const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
      try {
        await openAccessPanel(app)
        await expect.poll(() => app.frame.locator(PANEL).isVisible()).toBe(true)
        expect(await app.frame.locator(`${PANEL} img`).count(), '面板不再渲染二维码图片').toBe(0)
        expect(await removedCount(app), '已删除的行与块不再出现在面板里').toBe(0)
        expect(await app.frame.locator(LAN_DRAFT).count(), '监听地址未改动时不出现草稿行').toBe(0)
        expect(await app.frame.locator(PAIRING).count(), '访问控制卡始终给出临时配对码行').toBe(1)
        expect(await app.frame.locator(PERMANENT).count(), '访问控制卡始终给出永久访问码行').toBe(1)
        expect(await app.frame.locator(TOKEN_ROTATE).count(), '没有永久码时只给「生成」').toBe(1)
        expect(await app.frame.locator(PERMANENT_VALUE).count()).toBe(0)

        expect(await app.frame.locator(ACCESS_TOGGLE).count(), '局域网开关暴露 access-toggle').toBe(1)
        const lan = switchOf(app, LAN)
        expect(await lan.getAttribute('aria-checked')).toBe('false')
        await shoot(app, 'access-1-panel')

        await lan.click()
        await expect.poll(() => lan.getAttribute('aria-checked'), { timeout: 20_000 }).toBe('true')
        await expect.poll(() => app.frame.locator(LAN_ADDRESS).count(), { timeout: 20_000 }).toBe(1)

        const code = await readText(app, PAIRING_CODE)
        expect(code, '临时配对码是 8 位无易混淆字符').toMatch(CODE)
        await expect.poll(() => readText(app, PAIRING_COUNTDOWN), { timeout: 20_000 }).toMatch(/^剩余 \d+:\d{2}$/u)
        const status = await accessStatus()
        expect(status.enabled).toBe(true)
        expect(status.auth.enabled, '开启监听即自动带认证（开关已从面板移出）').toBe(true)
        expect(status.listen.address).toBe('127.0.0.1')
        expect(status.linkSource, '回环监听不外发局域网链接').toBe('loopback')
        expect(status.maskLink, '回环地址只以本机主机名给出').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u)
        expect(authParamOf(status.link), '回环 + 无永久码时链接不带凭据').toBeUndefined()
        expect(authParamOf(status.pairing?.link), '面板配对码就是宿主链接里的 auth').toBe(code)
        await shoot(app, 'access-2-loopback')

        await lan.click()
        await expect.poll(() => app.frame.locator(LAN_ADDRESS).count(), { timeout: 20_000 }).toBe(0)
        await expect.poll(() => readText(app, PAIRING_CODE), { timeout: 20_000 }).toBe('开启监听后这里会给出配对码。')
        expect(await app.frame.locator(PAIRING_COUNTDOWN).count(), '没有配对码时不再渲染倒计时').toBe(0)
      }
      finally {
        await resetExposure()
        await app.page.close()
      }
    }, 120_000)

    it('开放到全部网卡并签发永久码后，永久码掩码/显示/作废可往返', async () => {
      await resetExposure()
      await apiPost(ACCESS_API, { enabled: true, address: '0.0.0.0', authEnabled: true, password: 'e2e-panel-pass', scope: 'public_only' })
      await apiPost(`${ACCESS_API}/token`, {})
      const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
      try {
        await openAccessPanel(app)
        await expect.poll(() => app.frame.locator(PAIRING_CODE).count(), { timeout: 30_000 }).toBe(1)
        const status = await accessStatus()
        expect(status.linkSource, '全部网卡走局域网公开地址').toBe('lan')
        expect(status.listen.address).toBe('0.0.0.0')
        expect(status.link, '局域网入口带已签发的永久码').toMatch(/\?auth=/u)
        expect(status.auth.token).toMatch(CODE)
        expect(authParamOf(status.pairing?.link), '面板配对码就是宿主链接里的 auth').toBe(await readText(app, PAIRING_CODE))
        expect(await app.frame.locator(LAN_ADDRESS).count(), '已开启监听时给出监听地址行').toBe(1)

        expect(await app.frame.locator(TOKEN_ROTATE).count(), '已有永久码时不再给「生成」').toBe(0)
        expect(await readText(app, PERMANENT_VALUE), '永久码默认掩码').toBe(MASK)
        expect(await app.frame.locator(TOKEN_REVOKE).count()).toBe(1)
        await shoot(app, 'access-3-permanent-masked')

        await app.frame.locator(PERMANENT_REVEAL).click()
        await expect.poll(() => readText(app, PERMANENT_VALUE), { timeout: 20_000 }).toMatch(CODE)
        expect(await readText(app, PERMANENT_VALUE), '点显示才出明文，且与宿主一致').toBe(status.auth.token)

        await app.frame.locator(PERMANENT_REVEAL).click()
        await expect.poll(() => readText(app, PERMANENT_VALUE), { timeout: 20_000 }).toBe(MASK)
        await app.frame.locator(TOKEN_REVOKE).click()
        await expect.poll(() => app.frame.locator(PERMANENT_VALUE).count(), { timeout: 20_000 }).toBe(0)
        await expect.poll(() => app.frame.locator(TOKEN_ROTATE).count(), { timeout: 20_000 }).toBe(1)
        expect(authParamOf((await accessStatus()).pairing?.link), '作废永久码不影响临时配对码').toBe(await readText(app, PAIRING_CODE))
      }
      finally {
        await resetExposure()
        await app.page.close()
      }
    }, 120_000)
  })
})
