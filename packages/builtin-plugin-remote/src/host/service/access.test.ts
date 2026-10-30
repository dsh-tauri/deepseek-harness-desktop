import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HostWebRoute, RemoteHostContext } from '../types/index'
import type { RemoteAccessDocument, RemoteAccessStatus } from './access.types'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { toDataURL } from 'qrcode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSourceSession, setCurrentHostInstance } from '../config/runtime'
import { server as remoteServer } from '../server'
import { signDeviceSession, signSession, verifyDeviceSession, verifySession } from '../utils/auth'
import { access } from './access'
import { defaultAccessDocument, enumerateAddresses, isReachableAddress, readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'
import { consumePairingCode, pairingCodeOf, resetPairingCode } from './pairing'

const homes: string[] = []

let previousHome: string | undefined

let previousPort: string | undefined

let upstream: Upstream

let mintAuthorities: string[]

interface Reply {
  status: number
  body: string
  headers: IncomingHttpHeaders
}

interface Upstream {
  port: number
  calls: Array<{ url: string, cookie: string | undefined }>
  close: () => Promise<void>
}

/** 最小 DSH 等价上游：`/?token=` 铸造 authority 绑定 cookie，其余请求记录并回 200。 */
function startUpstream(): Promise<Upstream> {
  const calls: Upstream['calls'] = []
  const registered: HostWebRoute[] = []
  const disposeRoutes = remoteServer({
    webServer: { register: (route: HostWebRoute) => {
      registered.push(route)
      return () => {}
    } },
    logger: { error: () => {} },
  } as never)
  const server = createServer((request, response) => {
    const route = registered.find(entry => entry.path === new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (route !== undefined) {
      void route.handler(request, response)
      return
    }
    calls.push({ url: request.url ?? '', cookie: request.headers.cookie })
    if (request.url?.startsWith('/?token=')) {
      response.writeHead(303, { 'set-cookie': 'dsh-auth-probe=granted; Path=/', 'location': '/' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html' : 'application/json' })
    response.end(request.url === '/' ? '<html>dsh</html>' : '{"ok":true}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        port: address.port,
        calls,
        close: () => new Promise<void>((done) => {
          disposeRoutes()
          server.close(() => done())
        }),
      })
    })
  })
}

function call(port: number, path: string, options: { source?: string, cookie?: string, method?: string, form?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        connection: 'close',
        ...options.source === undefined ? {} : { 'x-dsh-remote-source': options.source, 'x-dsh-remote-session': ensureSourceSession() },
        ...options.cookie === undefined ? {} : { cookie: options.cookie },
        ...options.form === undefined ? {} : { 'accept': 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }))
    })
    request.on('error', reject)
    request.end(options.form)
  })
}

function signIn(port: number, code: string): Promise<Reply> {
  return call(port, '/', { source: 'public', method: 'POST', form: `code=${encodeURIComponent(code)}` })
}

function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}

function occupy(host: string, port: number): Promise<() => Promise<void>> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(() => new Promise<void>(done => server.close(() => done()))))
  })
}

/** 与 gateway.ts 的端口回落上限对齐：真实候选端口 = 首选 + 该上限。 */
const PORT_FALLBACK_LIMIT = 20

async function occupyRange(size: number): Promise<{ base: number, release: () => Promise<void> }> {
  for (let base = 20_000; base + size < 60_000; base += 256) {
    const releases: Array<() => Promise<void>> = []
    for (let offset = 0; offset < size; offset++) {
      try {
        releases.push(await occupy('127.0.0.1', base + offset))
      }
      catch {
        break
      }
    }
    if (releases.length === size) {
      return {
        base,
        release: async () => {
          for (const release of releases.reverse())
            await release()
        },
      }
    }
    for (const release of releases.reverse())
      await release()
  }
  throw new Error('测试断言失败：本机找不到连续空闲端口段')
}

function sessionCookieOf(headers: IncomingHttpHeaders): string {
  const values = headers['set-cookie'] ?? []
  const pair = values.map(value => value.split(';')[0] ?? '').find(value => value.startsWith('dsh_remote_session='))
  if (pair === undefined)
    throw new Error('测试断言失败：登录响应没有下发 dsh_remote_session')
  return pair
}

function tokenOf(link: string | undefined): string {
  const token = link === undefined ? null : new URL(link).searchParams.get('auth')
  if (token === null || token === '')
    throw new Error('测试断言失败：链接不含 auth 参数')
  return token
}

/** 本机必须至少存在一个可达地址：环境不满足直接失败，绝不静默跳过（plugin.test.md §7.1）。 */
function requireReachable(): string {
  const reachable = enumerateAddresses().filter(item => isReachableAddress(item.address))
  expect(reachable.length).toBeGreaterThan(0)
  const address = reachable[0]?.address
  if (address === undefined)
    throw new Error('测试断言失败：本机没有可达地址')
  return address
}

function ownReachable(): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (!info.internal && isReachableAddress(info.address))
        found.push(info.address)
    }
  }
  return found
}

beforeEach(async () => {
  resetPairingCode()
  previousHome = process.env.DSH_HOME
  previousPort = process.env.DSH_WEB_PORT
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-access-service-'))
  homes.push(process.env.DSH_HOME)
  upstream = await startUpstream()
  mintAuthorities = []
  process.env.DSH_WEB_PORT = String(upstream.port)
  setCurrentHostInstance({
    webServer: { register: () => () => {} },
    effect: () => {},
    connection: {
      authenticatedUrl: (base: string) => {
        mintAuthorities.push(new URL(base).host)
        return `${base}?token=launch-token`
      },
    },
  } as unknown as RemoteHostContext)
})

afterEach(async () => {
  await access.dispose()
  await gateway.dispose()
  await upstream.close()
  setCurrentHostInstance(undefined)
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = previousHome
  if (previousPort === undefined)
    delete process.env.DSH_WEB_PORT
  else
    process.env.DSH_WEB_PORT = previousPort
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
  resetPairingCode()
  vi.restoreAllMocks()
})

function storedDocument(): RemoteAccessDocument {
  return readAccessDocument().document
}

function documentFile(): string {
  return join(process.env.DSH_HOME ?? '', 'remote', 'access.json')
}

async function enable(address = '127.0.0.1', port?: number): Promise<RemoteAccessStatus> {
  return await access.apply({ enabled: true, address, port: port ?? await freePort() })
}

describe('access 监听生命周期', () => {
  it('会话密钥落盘且模块重载保持授权，撤销使设备票据与会话失效', async () => {
    await access.ensureAuth()
    const secret = access.policy().sessionSecret
    expect(secret).toMatch(/^[\w-]{43}$/u)
    expect(storedDocument().auth.sessionSecret).toBe(secret)
    const now = Date.now()
    const cookie = signSession(secret, now).value
    const device = signDeviceSession(secret, now).value
    const document = readFileSync(documentFile(), 'utf8')
    vi.resetModules()
    const fresh = (await import('./access')).access
    try {
      expect(fresh.policy().sessionSecret).toBe(secret)
      await fresh.restore()
      expect(readFileSync(documentFile(), 'utf8')).toBe(document)
      expect(verifySession(cookie, fresh.policy().sessionSecret, now)).toBe(true)
      expect(verifyDeviceSession(device, fresh.policy().sessionSecret, now + 365 * 24 * 60 * 60 * 1000)).toBe(true)
      const code = fresh.policy().pairingCode
      await fresh.revoke()
      expect(fresh.policy().sessionSecret).not.toBe(secret)
      expect(fresh.policy().pairingCode).not.toBe(code)
      expect(verifySession(cookie, fresh.policy().sessionSecret, now)).toBe(false)
      expect(verifyDeviceSession(device, fresh.policy().sessionSecret, now)).toBe(false)
      expect(JSON.stringify(await fresh.status())).not.toContain(fresh.policy().sessionSecret)
    }
    finally {
      await fresh.dispose()
    }
  })

  it('恢复旧配置只补一次会话密钥，即使只开隧道也保存授权', async () => {
    const document = { ...defaultAccessDocument(), auth: { enabled: true, token: null, scope: 'all' as const } }
    writeAccessDocument(document)
    await access.restore()
    const first = storedDocument()
    expect(first.auth.sessionSecret).toMatch(/^[\w-]{43}$/u)
    expect(first).toEqual({ ...document, auth: { ...document.auth, sessionSecret: first.auth.sessionSecret } })
    const saved = readFileSync(documentFile(), 'utf8')
    await access.restore()
    access.policy()
    expect(readFileSync(documentFile(), 'utf8')).toBe(saved)
    expect(JSON.stringify(await access.status())).not.toContain(first.auth.sessionSecret ?? 'missing-secret')
  })

  it('开启暴露仅使用配对码，不生成或保存访问密码', async () => {
    const status = await enable()
    expect(status.auth.enabled).toBe(true)
    expect(status.pairing?.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
    expect(status).not.toHaveProperty('generatedPassword')
    expect(status.auth).not.toHaveProperty('hasPassword')
    expect(storedDocument().auth).toEqual({ enabled: true, token: null, scope: 'public_only', sessionSecret: access.policy().sessionSecret })
  })

  it('隧道前置认证仅使用配对码，重复调用不生成永久凭据', async () => {
    const status = await access.ensureAuth()
    expect(status.auth.enabled).toBe(true)
    expect(status).not.toHaveProperty('generatedPassword')
    expect(status.auth).not.toHaveProperty('hasPassword')
    expect(storedDocument().auth).toEqual({ enabled: true, token: null, scope: 'public_only', sessionSecret: access.policy().sessionSecret })
    const code = access.policy().pairingCode
    await access.ensureAuth()
    expect(access.policy().pairingCode).toBe(code)
  })

  it('apply 开启回环监听后网关真实转发到本机 DSH 上游并注入原生 cookie', async () => {
    const status = await enable()
    expect(status.listening).toBe(true)
    expect(status.state).toBe('listening')
    expect(status.port).toBe(status.listen.port)
    expect(status.link).toBe(`http://127.0.0.1:${status.port}/`)
    const reply = await call(status.port, '/')
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('<html>dsh</html>')
    const forwarded = upstream.calls.find(entry => entry.url === '/')
    expect(mintAuthorities).toEqual([`127.0.0.1:${upstream.port}`])
    expect(forwarded?.cookie).toContain('dsh-auth-probe=granted')
  })

  it('回环监听也生成二维码并标注链接来源', async () => {
    const status = await enable()
    expect(status.qr).toMatch(/^data:image\/png;base64,/u)
    expect(status.linkSource).toBe('loopback')
    expect(status.error).toBeUndefined()
    expect(status.maskLink).toBe(`http://127.0.0.1:${status.port}/`)
  })

  it('启用暴露保留已有链接 Token，不把凭据写进事件环', async () => {
    await access.rotate()
    const token = storedDocument().auth.token
    expect(token).toBeTruthy()
    const status = await enable()
    expect(status.auth.token).toBe(token)
    expect(storedDocument().auth.token).toBe(token)
    expect(status.events.map(event => event.line).join('\n')).not.toContain(token ?? '')
  })

  it('access.json 损坏时所有写操作拒绝，且不覆盖原文件', async () => {
    mkdirSync(dirname(documentFile()), { recursive: true })
    writeFileSync(documentFile(), '{ not json')
    const before = readFileSync(documentFile(), 'utf8')
    await expect(access.apply({ enabled: true })).rejects.toThrowError('解析失败')
    await expect(access.rotate()).rejects.toThrowError('解析失败')
    await expect(access.revoke()).rejects.toThrowError('解析失败')
    await expect(access.ensureAuth()).rejects.toThrowError('解析失败')
    expect(readFileSync(documentFile(), 'utf8')).toBe(before)
  })

  it('关闭暴露后立即停止监听，且再次启动不自动开启', async () => {
    const status = await enable()
    const stopped = await access.apply({ enabled: false })
    expect(stopped.listening).toBe(false)
    expect(stopped.state).toBe('stopped')
    expect(stopped.link).toBeUndefined()
    expect(storedDocument().enabled).toBe(false)
    await expect(call(status.port, '/')).rejects.toThrowError()
    await access.dispose()
    await access.restore()
    expect((await access.status()).listening).toBe(false)
  })

  it('端口被占用时回落到下一个可用端口，链接与二维码都用真实端口', async () => {
    const address = requireReachable()
    const port = await freePort()
    const release = await occupy(address, port)
    try {
      const status = await enable(address, port)
      expect(status.port).toBe(port + 1)
      expect(status.listen.port).toBe(port)
      const host = address.includes(':') ? `[${address}]` : address
      expect(status.link).toBe(`http://${host}:${port + 1}/`)
      expect(status.maskLink).toBe(`http://${host}:${port + 1}/`)
      expect(status.qr).toBe(await toDataURL(`http://${host}:${port + 1}/`))
      expect(storedDocument().listen.port).toBe(port)
    }
    finally {
      await release()
    }
  })

  it('候选端口全部被占用时进入 error，并给出含尝试范围的可读原因', async () => {
    const { base, release } = await occupyRange(PORT_FALLBACK_LIMIT + 1)
    try {
      const status = await access.apply({ enabled: true, address: '127.0.0.1', port: base })
      expect(status.listening).toBe(false)
      expect(status.state).toBe('error')
      expect(status.error).toContain(`已尝试 ${base}-${base + PORT_FALLBACK_LIMIT}`)
      expect(status.link).toBeUndefined()
      expect(status.events.at(-1)?.line).toContain('入站暴露未开启')
    }
    finally {
      await release()
    }
  })

  it('选择全部网卡时链接使用本机评分最高的可达地址，绝不出现 0.0.0.0', async () => {
    const port = await freePort()
    const status = await enable('0.0.0.0', port)
    expect(status.listening).toBe(true)
    expect(status.recommended).toBe(status.addresses.find(item => item.recommended)?.address)
    expect(ownReachable()).toContain(status.recommended)
    expect(status.link).not.toContain('0.0.0.0')
    expect(status.link).toContain(`:${status.port}/`)
    expect(status.qr).toBe(await toDataURL(status.link ?? ''))
  })

  it('显式关掉认证再暴露时，仍对公网与隧道来源给出未配置引导', async () => {
    const address = requireReachable()
    const port = await freePort()
    await access.apply({ authEnabled: false, enabled: true, address, port })
    const status = await access.status()
    expect(status.state).toBe('listening')
    expect(status.auth.enabled).toBe(false)
    const warning = status.events.find(event => event.kind === 'auth')
    expect(warning?.line).toContain('未开启访问认证')
  })

  it('重启后按上次的 enabled 与监听配置自动恢复', async () => {
    const port = await freePort()
    const applied = await enable('127.0.0.1', port)
    await access.dispose()
    await access.restore()
    const restored = await access.status()
    expect(restored.listening).toBe(true)
    expect(restored.port).toBe(applied.port)
    expect(restored.link).toBe(applied.link)
    const stored = storedDocument()
    expect(stored).toEqual({ ...defaultAccessDocument(), enabled: true, listen: { address: '127.0.0.1', port }, auth: { enabled: true, token: null, scope: 'public_only', sessionSecret: access.policy().sessionSecret } })
  })

  it('恢复失败时保持关闭并给出可读原因，且不静默改写配置', async () => {
    writeAccessDocument({ ...defaultAccessDocument(), enabled: true, listen: { address: '203.0.113.7', port: 3088 } })
    await expect(access.restore()).resolves.toBeUndefined()
    const status = await access.status()
    expect(status.listening).toBe(false)
    expect(status.state).toBe('error')
    expect(status.error).toContain('已不存在')
    expect(storedDocument()).toEqual({ ...defaultAccessDocument(), enabled: true, listen: { address: '203.0.113.7', port: 3088 } })
  })

  it('缺少 DSH_WEB_PORT 时用宿主 webserver 的实监听端口作为上游（非桌面载体）', async () => {
    delete process.env.DSH_WEB_PORT
    setCurrentHostInstance({
      webServer: { register: () => () => {}, port: upstream.port },
      effect: () => {},
      connection: {
        authenticatedUrl: (base: string) => {
          mintAuthorities.push(new URL(base).host)
          return `${base}?token=launch-token`
        },
      },
    } as unknown as RemoteHostContext)
    const status = await enable()
    expect(status.listening).toBe(true)
    expect(status.localPort).toBe(upstream.port)
    const reply = await call(status.port, '/')
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('<html>dsh</html>')
  })

  it('宿主 webserver 与 DSH_WEB_PORT 都缺失时明确报错而不是硬编码上游端口', async () => {
    delete process.env.DSH_WEB_PORT
    const status = await access.apply({ enabled: true })
    expect(status.listening).toBe(false)
    expect(status.state).toBe('error')
    expect(status.error).toContain('DSH_WEB_PORT')
  })

  it('损坏的 access.json 不阻断恢复，且文件保留在磁盘上', async () => {
    mkdirSync(dirname(documentFile()), { recursive: true })
    writeFileSync(documentFile(), '{ broken')
    await expect(access.restore()).resolves.toBeUndefined()
    const status = await access.status()
    expect(status.listening).toBe(false)
    expect(status.error).toContain('解析失败')
    expect(status.warnings?.[0]).toContain('解析失败')
    expect(readFileSync(documentFile(), 'utf8')).toBe('{ broken')
  })
})

describe('access 临时码消费与长轮询（真实路由和网关）', () => {
  it('宿主策略消费成功后响应新码和 usedSeq，永久凭据及既有会话保持不变', async () => {
    const status = await enable()
    const first = status.pairing
    expect(first).toMatchObject({ usedSeq: 0 })
    const document = readFileSync(documentFile(), 'utf8')
    const login = await signIn(status.port, first?.code.toLowerCase() ?? '')
    expect(login.status).toBe(302)
    const next = await access.status()
    expect(next.pairing?.usedSeq).toBe(1)
    expect(next.pairing?.code).not.toBe(first?.code)
    expect(readFileSync(documentFile(), 'utf8')).toBe(document)
    expect((await signIn(status.port, first?.code ?? '')).status).toBe(401)
    expect((await call(status.port, '/api/probe', { source: 'public', cookie: sessionCookieOf(login.headers) })).status).toBe(200)
    expect((await access.status()).pairing?.usedSeq).toBe(1)
  })

  it('回环 GET/access 在临时码消费后立即唤醒，迟到的 cursor 直接返回', async () => {
    const status = await enable()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const path = '/api/tauri/remote/access?sincePairingUseSeq=0'
    const pending = call(upstream.port, path)
    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(true))
    expect((await signIn(status.port, status.pairing?.code.toLowerCase() ?? '')).status).toBe(302)
    const reply = await pending
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body).pairing).toMatchObject({ usedSeq: 1 })
    expect(JSON.parse(reply.body).pairing.code).not.toBe(status.pairing?.code)
    timers.mockClear()
    const late = await call(upstream.port, path)
    expect(late.status).toBe(200)
    expect(JSON.parse(late.body).pairing.usedSeq).toBe(1)
    expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(false)
  })

  it('gET/access 验证安全整数 cursor，非回环及伪造来源拒绝且不等待', async () => {
    await enable()
    for (const cursor of ['', '-1', '1.5', 'oops', '9007199254740992', 'Infinity', '0&sincePairingUseSeq=0']) {
      const reply = await call(upstream.port, `/api/tauri/remote/access?sincePairingUseSeq=${cursor}`)
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.body).message).toBe('invalid sincePairingUseSeq')
    }
    const timers = vi.spyOn(globalThis, 'setTimeout')
    for (const source of ['public', 'private', 'tunnel']) {
      const reply = await call(upstream.port, '/api/tauri/remote/access?sincePairingUseSeq=0', { source })
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.body)).toEqual({ error: '管理接口仅限本机回环来源' })
    }
    const forged = await fetch(`http://127.0.0.1:${upstream.port}/api/tauri/remote/access?sincePairingUseSeq=0`, { headers: { 'connection': 'close', 'x-dsh-remote-source': 'loopback', 'x-dsh-remote-session': 'forged' } })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toEqual({ error: '管理接口仅限本机回环来源' })
    expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(false)
  })

  it('gET/access 长轮询客户端取消时清理定时器，dispose 结束残留等待', async () => {
    await enable()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${upstream.port}/api/tauri/remote/access?sincePairingUseSeq=0`, { headers: { connection: 'close' }, signal: controller.signal })
    const cancelled = pending.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(true))
    }
    finally {
      controller.abort()
    }
    const timer = timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 8000)]?.value
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(cleared.mock.calls.some(([handle]) => handle === timer)).toBe(true))
    timers.mockClear()
    const remaining = call(upstream.port, '/api/tauri/remote/access?sincePairingUseSeq=0')
    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(true))
    await access.dispose()
    expect((await remaining).status).toBe(200)
    expect(pairingCodeOf().usedSeq).toBe(0)
  })

  it('tTL 自动轮换不记为消费，长轮询八秒超时仍返回最新状态', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const status = await enable()
    expect(status.pairing?.usedSeq).toBe(0)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const pending = call(upstream.port, '/api/tauri/remote/access?sincePairingUseSeq=0')
    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => delay === 8000)).toBe(true))
    clock.mockReturnValue(status.pairing?.expiresAt ?? 0)
    const reply = await pending
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body).pairing.usedSeq).toBe(0)
    expect(JSON.parse(reply.body).pairing.code).not.toBe(status.pairing?.code)
    expect(consumePairingCode(JSON.parse(reply.body).pairing.code)).toBe(true)
    expect(pairingCodeOf().usedSeq).toBe(1)
  })
})

describe('access 认证与来源判定（经真实网关）', () => {
  it('开启暴露即使用配对码：私网放行，公网与隧道来源进入配对而非未配置引导', async () => {
    const status = await enable()
    expect(status.pairing?.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
    expect((await call(status.port, '/api/probe', { source: 'private' })).status).toBe(200)
    const publicReply = await call(status.port, '/api/probe', { source: 'public' })
    expect(publicReply.status).toBe(401)
    expect(publicReply.body).toContain('需要认证')
    const loginPage = await call(status.port, '/', { source: 'public', form: undefined })
    expect(loginPage.status).toBe(401)
    expect((await call(status.port, '/api/probe', { source: 'tunnel' })).status).toBe(401)
  })

  it('用户显式关掉认证后，公网与隧道来源回到未配置引导并拒绝', async () => {
    const status = await enable()
    await access.apply({ authEnabled: false })
    const publicReply = await call(status.port, '/api/probe', { source: 'public' })
    expect(publicReply.status).toBe(403)
    expect(publicReply.body).toContain('尚未启用配对认证')
    expect((await call(status.port, '/api/probe', { source: 'tunnel' })).status).toBe(403)
  })

  it('scope=public_only 时私网免密、公网要求认证；scope=all 时私网也要求认证', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, scope: 'public_only' })
    expect((await call(status.port, '/api/probe', { source: 'private' })).status).toBe(200)
    expect((await call(status.port, '/api/probe', { source: 'public' })).status).toBe(401)
    await access.apply({ scope: 'all' })
    expect((await call(status.port, '/api/probe', { source: 'private' })).status).toBe(401)
  })

  it('链接 Token 可换到会话并 302 到干净 URL，轮换后旧链接立即失效', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, scope: 'all' })
    const rotated = await access.rotate()
    const first = tokenOf(rotated.link)
    const exchanged = await call(status.port, `/?auth=${first}`, { source: 'public' })
    expect(exchanged.status).toBe(302)
    expect(exchanged.headers.location).toBe('/')
    const cookie = sessionCookieOf(exchanged.headers)
    expect((await call(status.port, '/api/probe', { source: 'public', cookie })).status).toBe(200)

    const next = await access.rotate()
    const second = tokenOf(next.link)
    expect(second).not.toBe(first)
    expect((await call(status.port, `/?auth=${first}`, { source: 'public' })).status).toBe(401)
    const again = await call(status.port, `/?auth=${second}`, { source: 'public' })
    expect(again.status).toBe(302)
    expect(again.headers.location).toBe('/')
  })

  it('撤销授权后旧链接和已签发会话立即失效', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, scope: 'public_only' })
    const rotated = await access.rotate()
    const token = tokenOf(rotated.link)
    const exchanged = await call(status.port, `/?auth=${token}`, { source: 'public' })
    const cookie = sessionCookieOf(exchanged.headers)
    const revoked = await access.revoke()
    expect(revoked.auth.hasToken).toBe(false)
    expect(revoked.link).toBe(`http://127.0.0.1:${status.port}/`)
    expect((await call(status.port, `/?auth=${token}`, { source: 'public' })).status).toBe(401)
    expect((await call(status.port, '/api/probe', { source: 'public', cookie })).status).toBe(401)
  })

  it('配对码连续错误达阈值后封禁并返回可读剩余时间', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, scope: 'public_only' })
    const attempts: number[] = []
    for (let index = 0; index < 5; index++)
      attempts.push((await signIn(status.port, 'wrong')).status)
    expect(attempts).toEqual([401, 401, 401, 401, 429])
    const banned = await signIn(status.port, status.pairing?.code ?? '')
    expect(banned.status).toBe(429)
    expect(banned.body).toContain('认证失败次数过多')
  })

  it('保存时丢弃未知键并告警，其余键保留且不整体覆盖为默认值', async () => {
    mkdirSync(dirname(documentFile()), { recursive: true })
    writeFileSync(documentFile(), `${JSON.stringify({ version: 1, enabled: false, listen: { address: '127.0.0.1', port: 3300 }, rogue: true }, null, 2)}\n`)
    const status = await access.apply({ authEnabled: true })
    expect(status.listen.port).toBe(3300)
    expect(status.auth.enabled).toBe(true)
    expect(status.events.map(event => event.line)).toContain('access.json 丢弃未知键 rogue')
    expect(Object.keys(JSON.parse(readFileSync(documentFile(), 'utf8')))).toEqual(['version', 'enabled', 'listen', 'auth', 'tunnel'])
  })
})
