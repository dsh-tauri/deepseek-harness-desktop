import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RemoteHostContext } from '../types/index'
import type { RemoteAccessDocument, RemoteAccessStatus } from './access.types'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { toDataURL } from 'qrcode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSourceSession, setCurrentHostInstance } from '../config/runtime'
import { verifyPassword } from '../utils/auth'
import { access } from './access'
import { defaultAccessDocument, enumerateAddresses, isReachableAddress, readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'

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
  const server = createServer((request, response) => {
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
        close: () => new Promise<void>(done => server.close(() => done())),
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

function signIn(port: number, password: string): Promise<Reply> {
  return call(port, '/', { source: 'public', method: 'POST', form: `password=${encodeURIComponent(password)}` })
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

  it('回环监听不生成二维码也不属于错误状态', async () => {
    const status = await enable()
    expect(status.qr).toBeUndefined()
    expect(status.error).toBeUndefined()
    expect(status.maskLink).toBe(`http://127.0.0.1:${status.port}/`)
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

  it('暴露到非回环地址且未配置任何凭据时产生显式提示事件', async () => {
    const address = requireReachable()
    const port = await freePort()
    const status = await enable(address, port)
    expect(status.state).toBe('listening')
    const warning = status.events.find(event => event.kind === 'auth')
    expect(warning?.line).toContain('未配置访问密码或链接 Token')
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
    expect(storedDocument()).toEqual({ ...defaultAccessDocument(), enabled: true, listen: { address: '127.0.0.1', port } })
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

describe('access 认证与来源判定（经真实网关）', () => {
  it('未配置认证时私网来源放行、公网与隧道来源 403 并给出引导', async () => {
    const status = await enable()
    expect((await call(status.port, '/api/probe', { source: 'private' })).status).toBe(200)
    const publicReply = await call(status.port, '/api/probe', { source: 'public' })
    expect(publicReply.status).toBe(403)
    expect(publicReply.body).toContain('尚未配置访问认证')
    expect((await call(status.port, '/api/probe', { source: 'tunnel' })).status).toBe(403)
  })

  it('scope=public_only 时私网免密、公网要求认证；scope=all 时私网也要求认证', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, password: 'hunter2', scope: 'public_only' })
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

  it('作废 Token 后旧链接失效，已签发的会话不受影响', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, password: 'hunter2', scope: 'public_only' })
    const rotated = await access.rotate()
    const token = tokenOf(rotated.link)
    const exchanged = await call(status.port, `/?auth=${token}`, { source: 'public' })
    const cookie = sessionCookieOf(exchanged.headers)
    const revoked = await access.revoke()
    expect(revoked.auth.hasToken).toBe(false)
    expect(revoked.link).toBe(`http://127.0.0.1:${status.port}/`)
    expect((await call(status.port, `/?auth=${token}`, { source: 'public' })).status).toBe(401)
    expect((await call(status.port, '/api/probe', { source: 'public', cookie })).status).toBe(200)
  })

  it('密码连续错误达阈值后封禁并返回可读剩余时间', async () => {
    const status = await enable()
    await access.apply({ authEnabled: true, password: 'hunter2', scope: 'public_only' })
    const attempts: number[] = []
    for (let index = 0; index < 5; index++)
      attempts.push((await signIn(status.port, 'wrong')).status)
    expect(attempts).toEqual([401, 401, 401, 401, 429])
    const banned = await signIn(status.port, 'hunter2')
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

  it('密码只以哈希落盘且校验通过，明文不出现在配置文档里', async () => {
    await access.apply({ password: 'hunter2' })
    const password = storedDocument().auth.password
    expect(password?.algo).toBe('pbkdf2-sha256')
    expect(verifyPassword('hunter2', password)).toBe(true)
    expect(readFileSync(documentFile(), 'utf8')).not.toContain('hunter2')
    const cleared = await access.apply({ password: null })
    expect(cleared.auth.hasPassword).toBe(false)
    expect(storedDocument().auth.password).toBeNull()
  })
})
