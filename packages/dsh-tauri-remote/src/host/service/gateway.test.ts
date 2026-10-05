import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteAuthPolicy, RemoteGatewayEntryKind, RemoteGatewayEvent, RemoteGatewayStartOptions, RemotePasswordRecord } from '../types/index'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_SESSION_HEADER, GATEWAY_SOURCE_HEADER } from '../config/constants'
import { ensureSourceSession } from '../config/runtime'
import { createLinkToken, hashPassword, signSession, verifySession } from '../utils/auth'
import { gateway } from './gateway'

const SESSION = ensureSourceSession()

const MIN_BYTES = 1024

interface Coded {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

interface Streamed {
  status: number
  headers: IncomingHttpHeaders
  stream: IncomingMessage
}

interface Upgraded {
  status: number
  headers: IncomingHttpHeaders
  socket: Duplex
}

interface UpstreamCall {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

interface FakeUpstream {
  port: number
  origin: string
  calls: UpstreamCall[]
  upgrades: UpstreamCall[]
  mintCount: number
  token: string
  mintUrlFor: (authority: string) => Promise<string>
  restart: () => void
  releaseEvents: () => void
  waitForCall: (url: string) => Promise<void>
  waitForStall: () => Promise<void>
  close: () => Promise<void>
}

function loopbackHost(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost'
}

function cookieOf(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.cookie
  return Array.isArray(value) ? value.join('; ') : value
}

function cookieValueOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  return (cookieOf(headers) ?? '')
    .split(';')
    .map(pair => pair.trim())
    .find(pair => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function localAuthorityOf(headers: IncomingHttpHeaders): string | undefined {
  const host = headers.host
  if (typeof host !== 'string' || host === '')
    return undefined
  try {
    return new URL(`http://${host}`).host
  }
  catch {
    return undefined
  }
}

/** 与 DSH 真实实现同构的会话 cookie 名：`dsh-auth-` + base64url(sha256(authority))。 */
function cookieNameOf(authority: string): string {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
}

function grantedCookieOf(headers: IncomingHttpHeaders): string | undefined {
  const authority = localAuthorityOf(headers)
  return authority === undefined ? undefined : cookieValueOf(headers, cookieNameOf(authority))
}

/** 最小 DSH 等价上游：Host/Origin/Sec-Fetch-Site fence + authority 绑定 cookie + 静态资源 + /api + SSE + Upgrade。 */
function startFakeUpstream(): Promise<FakeUpstream> {
  const granted = new Map<string, Set<string>>()
  const waiters = new Map<string, Array<() => void>>()
  const state = {
    token: 'launch-token-1',
    sequence: 0,
    mintCount: 0,
    calls: [] as UpstreamCall[],
    upgrades: [] as UpstreamCall[],
    release: (): void => {},
    stalled: (): void => {},
  }
  const fenced = (headers: IncomingHttpHeaders, pathname: string): boolean => {
    const authority = localAuthorityOf(headers)
    if (authority === undefined || !loopbackHost(new URL(`http://${authority}`).hostname))
      return false
    if (pathname.startsWith('/api/') && headers['sec-fetch-site'] === 'cross-site')
      return false
    const origin = headers.origin
    if (typeof origin !== 'string')
      return true
    try {
      return new URL(origin).host === authority
    }
    catch {
      return false
    }
  }
  const sessionGranted = (headers: IncomingHttpHeaders): boolean => {
    const authority = localAuthorityOf(headers)
    const value = grantedCookieOf(headers)
    return authority !== undefined && value !== undefined && (granted.get(authority)?.has(value) ?? false)
  }
  const sockets = new Set<Duplex>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    state.calls.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
    for (const release of waiters.get(url.pathname) ?? [])
      release()
    waiters.delete(url.pathname)
    if (!fenced(request.headers, url.pathname)) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('fence')
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const tokens = url.searchParams.getAll('token')
      if (tokens.length === 1) {
        if (tokens[0] !== state.token) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end('{"error":"bad token"}')
          return
        }
        state.mintCount += 1
        state.sequence += 1
        const value = `mint-${state.sequence}`
        const authority = localAuthorityOf(request.headers) ?? ''
        const name = cookieNameOf(authority)
        const values = granted.get(authority) ?? new Set<string>()
        values.add(value)
        granted.set(authority, values)
        response.writeHead(303, { 'location': './', 'set-cookie': `${name}=${value}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` })
        response.end()
        return
      }
    }
    if (!sessionGranted(request.headers)) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"unauthorized"}')
      return
    }
    if (url.pathname === '/') {
      const html = `<html><body>${'x'.repeat(3000)}</body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)) })
      response.end(html)
      return
    }
    if (url.pathname === '/api/ping') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    if (url.pathname === '/api/echo') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.stringify({ received: Buffer.concat(chunks).length })
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
        response.end(body)
      })
      return
    }
    if (url.pathname === '/big') {
      const text = 'b'.repeat(MIN_BYTES * 4)
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(text.length) })
      response.end(text)
      return
    }
    if (url.pathname === '/chunked') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.write('c'.repeat(MIN_BYTES))
      response.end('d'.repeat(MIN_BYTES))
      return
    }
    if (url.pathname === '/small') {
      const text = 'tiny'
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(text.length) })
      response.end(text)
      return
    }
    if (url.pathname === '/chunked-small') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"ok":true}')
      return
    }
    if (url.pathname === '/image') {
      const png = Buffer.alloc(MIN_BYTES * 2, 7)
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      response.end(png)
      return
    }
    if (url.pathname === '/gz') {
      const body = zlib.gzipSync(Buffer.from('g'.repeat(MIN_BYTES * 2)))
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(body.length) })
      response.end(body)
      return
    }
    if (url.pathname === '/sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: one\n\n')
      state.release = () => {
        response.write('data: two\n\n')
        response.end()
      }
      return
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
      response.end()
      return
    }
    if (url.pathname === '/upstream-cookie') {
      const body = 'with-cookie'
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), 'set-cookie': 'dsh_upstream_credential=leaked; Path=/; HttpOnly' })
      response.end(body)
      return
    }
    if (url.pathname === '/abort-big' || url.pathname === '/abort-small') {
      const size = url.pathname === '/abort-big' ? MIN_BYTES * 4 : 300
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.write('x'.repeat(size))
      setTimeout(() => {
        request.socket.destroy()
      }, 20)
      return
    }
    if (url.pathname === '/gz-abort') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' })
      response.write(zlib.gzipSync(Buffer.from('g'.repeat(MIN_BYTES * 4))))
      setTimeout(() => {
        request.socket.destroy()
      }, 20)
      return
    }
    if (url.pathname === '/gz-sse-abort') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      response.write(zlib.gzipSync(Buffer.from('data: one\n\n')))
      setTimeout(() => {
        request.socket.destroy()
      }, 20)
      return
    }
    if (url.pathname === '/stall') {
      state.stalled()
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  server.on('upgrade', (request, socket) => {
    state.upgrades.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
    if ((request.url ?? '') === '/stall') {
      state.stalled()
      return
    }
    /** 恒定用过期凭据拒绝，使升级路径总是走到 401 重铸分支（重铸窗口的活性用例需要它）。 */
    if ((request.url ?? '') === '/retry') {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    if (!fenced(request.headers, request.url ?? '/') || !sessionGranted(request.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    if ((request.url ?? '') === '/upgrade-403' || (request.url ?? '') === '/upgrade-404') {
      const status = request.url === '/upgrade-403' ? '403 Forbidden' : '404 Not Found'
      const body = 'denied by upstream'
      socket.write((request.url ?? '') === '/upgrade-403'
        ? `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        : `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`)
      socket.end()
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.write('echo:hello')
    socket.on('data', (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        calls: state.calls,
        upgrades: state.upgrades,
        get mintCount() {
          return state.mintCount
        },
        get token() {
          return state.token
        },
        set token(next: string) {
          state.token = next
        },
        mintUrlFor: async (authority: string) => `http://${authority}/?token=${state.token}`,
        restart: () => {
          state.sequence += 1
          state.token = `launch-token-${state.sequence + 1}`
          granted.clear()
        },
        releaseEvents: () => state.release(),
        waitForCall: (path: string) => new Promise<void>((resolve) => {
          const pending = waiters.get(path) ?? []
          pending.push(resolve)
          waiters.set(path, pending)
        }),
        waitForStall: () => new Promise<void>((resolve) => {
          state.stalled = resolve
        }),
        close: () => new Promise<void>((done) => {
          for (const socket of sockets)
            socket.destroy()
          server.close(() => done())
        }),
      } as FakeUpstream)
    })
  })
}

interface RawUpstream {
  port: number
  origin: string
  requests: string[]
  waitForRequests: (count: number) => Promise<string[]>
  close: () => Promise<void>
}

/** 逐块切出上游连接上的一个完整请求：正文只按声明的方式定位，绝不把裸尾部字节当成正文。 */
function splitMessage(buffer: Buffer): { head: string, body: Buffer, rest: Buffer } | undefined {
  const at = buffer.indexOf('\r\n\r\n')
  if (at === -1)
    return undefined
  const head = buffer.subarray(0, at).toString('latin1')
  const start = at + 4
  if (/^transfer-encoding:\s*chunked$/im.test(head)) {
    let cursor = start
    while (cursor < buffer.length) {
      const lineEnd = buffer.indexOf('\r\n', cursor)
      if (lineEnd === -1)
        return undefined
      const size = Number.parseInt(buffer.subarray(cursor, lineEnd).toString('latin1'), 16)
      if (!Number.isInteger(size))
        return { head, body: buffer.subarray(start), rest: Buffer.alloc(0) }
      if (size === 0) {
        const end = lineEnd + 2 + 2
        if (buffer.length < end)
          return undefined
        return { head, body: buffer.subarray(start, end), rest: buffer.subarray(end) }
      }
      const next = lineEnd + 2 + size + 2
      if (buffer.length < next)
        return undefined
      cursor = next
    }
    return undefined
  }
  const declared = /^content-length:\s*(\d+)$/im.exec(head)
  const length = declared === null ? 0 : Number(declared[1])
  if (buffer.length < start + length)
    return undefined
  return { head, body: buffer.subarray(start, start + length), rest: buffer.subarray(start + length) }
}

/** 裸 TCP 上游：按原始字节记录网关写出的每个请求，铸造型请求就地回 303 + set-cookie。 */
function rawUpstream(): Promise<RawUpstream> {
  const requests: string[] = []
  const waiters: Array<() => void> = []
  const sockets = new Set<Duplex>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const drain = (): void => {
      for (;;) {
        const parsed = splitMessage(buffer)
        if (parsed === undefined)
          return
        buffer = parsed.rest
        requests.push(`${parsed.head}\r\n\r\n${parsed.body.toString('latin1')}`)
        for (const release of waiters.splice(0))
          release()
        if (parsed.head.startsWith('GET /?token='))
          socket.write('HTTP/1.1 303 See Other\r\nset-cookie: minted=1; Path=/\r\ncontent-length: 0\r\n\r\n')
        else
          socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: 2\r\n\r\nok')
      }
    }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      drain()
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        waitForRequests: async (count: number) => {
          while (requests.length < count) {
            await new Promise<void>((done) => {
              waiters.push(done)
              setTimeout(done, 3000)
            })
          }
          return requests
        },
        close: () => new Promise<void>((done) => {
          for (const socket of sockets)
            socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

function headOf(raw: string): string {
  const at = raw.indexOf('\r\n\r\n')
  return at === -1 ? raw : raw.slice(0, at)
}

function bodyOf(raw: string): string {
  const at = raw.indexOf('\r\n\r\n')
  return at === -1 ? '' : raw.slice(at + 4)
}

/** 按分块编码解出正文：解出内容与原文一致，才说明这串字节在上游连接上仍是一段正文。 */
function decodeChunked(body: string): string {
  let cursor = 0
  let decoded = ''
  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor)
    if (lineEnd === -1)
      break
    const size = Number.parseInt(body.slice(cursor, lineEnd), 16)
    if (!Number.isInteger(size) || size === 0)
      break
    decoded += Buffer.from(body.slice(lineEnd + 2, lineEnd + 2 + size), 'latin1').toString('latin1')
    cursor = lineEnd + 2 + size + 2
  }
  return decoded
}

function call(port: number, path: string, options: { method?: string, headers?: IncomingHttpHeaders, body?: Buffer | string } = {}): Promise<Coded> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: { connection: 'close', ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end(options.body)
  })
}

function streamed(port: number, path: string, headers: IncomingHttpHeaders = {}): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response })
    })
    request.on('error', reject)
    request.end()
  })
}

/** 裸 socket 回读网关写出的原始升级响应字节：非 101 的分帧只有在这一层才可判。 */
function rawUpgrade(port: number, path: string, headers: IncomingHttpHeaders): Promise<{ head: string, body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${port}`, 'connection: Upgrade', 'upgrade: websocket', ...Object.entries(headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const at = text.indexOf('\r\n\r\n')
      resolve({ head: at === -1 ? text : text.slice(0, at), body: at === -1 ? '' : text.slice(at + 4) })
    })
    setTimeout(() => socket.destroy(), 2000)
  })
}

/** 半关闭的升级连接不会触发 'close'：客户端断开必须等 'end' 或 'close' 两条都观测。 */
function disconnect(socket: Duplex): Promise<void> {
  return new Promise((resolve) => {
    socket.on('close', () => resolve())
    socket.on('end', () => resolve())
    socket.destroy()
  })
}

/** 发起升级握手但不等应答：上游是 /stall，网关只会把请求转出去。 */
function stalledUpgrade(port: number, headers: IncomingHttpHeaders, path = '/stall'): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${port}`, 'connection: Upgrade', 'upgrade: websocket', ...Object.entries(headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      resolve(socket)
    })
    socket.on('error', reject)
  })
}

/** 假时钟下推进时间不会推进真实 I/O，这里让事件循环转光再回读客户端已经收到的字节。 */
async function settledTextOf(pending: Promise<string>): Promise<string> {
  let text = ''
  void pending.then((value) => {
    text = value
  })
  await new Promise(resolve => setImmediate(resolve))
  return text
}

async function turns(count: number): Promise<void> {
  for (let index = 0; index < count; index++)
    await new Promise(resolve => setImmediate(resolve))
}

/** 假时钟下推进时间不会推进真实 I/O：等待真实轮次而不是 waitFor（后者按真实时间轮询，会在假时钟下失去意义）。 */
async function until(condition: () => boolean, turnsPerAttempt = 4, attempts = 250): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition())
      return
    await turns(turnsPerAttempt)
  }
  throw new Error('等待条件超时')
}

function upgraded(port: number, path: string, headers: IncomingHttpHeaders): Promise<Upgraded> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    request.on('upgrade', (response, socket, head) => {
      if (head.length > 0)
        socket.unshift(head)
      resolve({ status: response.statusCode ?? 0, headers: response.headers, socket })
    })
    request.on('response', (response) => {
      response.resume()
      response.on('end', () => reject(new Error(`升级被拒：${response.statusCode ?? 0}`)))
    })
    request.on('error', reject)
    request.end()
  })
}

interface Observed {
  kind: 'end' | 'aborted' | 'error' | 'no-response'
  status: number
  bodyLength: number
}

/** 观测一次响应如何终止：正常结束 / 中途断开 / 无响应，用于断言「上游断流」后的客户端所见。 */
function observed(port: number, path: string, headers: IncomingHttpHeaders, timeoutMs = 2000): Promise<Observed> {
  return new Promise((resolve) => {
    let settled = false
    let length = 0
    const finish = (kind: Observed['kind'], status = 0): void => {
      if (settled)
        return
      settled = true
      resolve({ kind, status, bodyLength: length })
    }
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { connection: 'close', ...headers }, agent: false }, (response) => {
      const status = response.statusCode ?? 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
      })
      response.on('end', () => finish('end', status))
      response.on('aborted', () => finish('aborted', status))
      response.on('error', () => finish('error', status))
    })
    request.on('error', () => finish('error'))
    setTimeout(finish, timeoutMs, 'no-response')
    request.end()
  })
}

function decodeReply(reply: Coded): string {
  const coding = reply.headers['content-encoding']
  if (coding === 'zstd')
    return zlib.zstdDecompressSync(reply.body).toString('utf8')
  if (coding === 'gzip')
    return zlib.gunzipSync(reply.body).toString('utf8')
  return reply.body.toString('utf8')
}

function markerHeaders(source: string, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders {
  return { [GATEWAY_SOURCE_HEADER]: source, [GATEWAY_SESSION_HEADER]: SESSION, ...extra }
}

/** cloudflared 把 Host 改写成回环 authority，但浏览器发出的 Fetch 元数据原样转发。 */
function tunnelHeaders(cookie: string, extra: IncomingHttpHeaders = {}): IncomingHttpHeaders {
  return { cookie, 'sec-fetch-site': 'same-origin', ...extra }
}

function navigation(): IncomingHttpHeaders {
  return { accept: 'text/html,application/xhtml+xml' }
}

function policyOf(overrides: Partial<RemoteAuthPolicy> = {}): RemoteAuthPolicy {
  return { enabled: true, scope: 'public_only', password: hashPassword('s3cret', 1000), linkToken: null, sessionSecret: 'session-secret', ...overrides }
}

async function startEntry(kind: RemoteGatewayEntryKind, upstream: FakeUpstream, options: Partial<RemoteGatewayStartOptions> = {}) {
  return await gateway.start({ id: 'entry', kind, upstream: upstream.origin, port: 0, ...options })
}

async function freePort(): Promise<{ port: number, release: () => Promise<void> }> {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, release: () => new Promise<void>((done) => {
    server.close(() => done())
  }) }
}

let upstream: FakeUpstream

beforeEach(async () => {
  upstream = await startFakeUpstream()
})

afterEach(async () => {
  await gateway.dispose()
  await upstream.close()
})

describe('gateway 转发与 DSH 原生 cookie 注入', () => {
  it('自动铸造并注入上游会话 cookie，浏览器侧无需任何凭据', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await call(status.port, '/api/ping')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('{"ok":true}')
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.url).toBe('/?token=launch-token-1')
    expect(grantedCookieOf(upstream.calls[1]?.headers ?? {})).toMatch(/^mint-/)
  })

  it('按上游 authority 缓存铸造结果，命中即直接注入', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(status.port, '/api/ping')
    await call(status.port, '/api/ping')
    await call(status.port, '/api/ping')
    expect(upstream.mintCount).toBe(1)
  })

  it('冷缓存下的并发请求共用一次铸造', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const replies = await Promise.all([1, 2, 3, 4, 5].map(async () => await call(status.port, '/api/ping')))
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200, 200])
    expect(upstream.mintCount).toBe(1)
  })

  it('入口停止后同一 authority 的铸造结果失效，重新开启时重新铸造', async () => {
    await withReservedPort(async (preferred) => {
      const first = await gateway.start({ id: 'entry', kind: 'outbound', upstream: upstream.origin, port: preferred, tokenProvider: upstream.mintUrlFor })
      expect(first.port).toBe(preferred)
      const warm = await call(preferred, '/api/echo', { method: 'POST', body: 'x' })
      expect(warm.status).toBe(200)
      expect(upstream.mintCount).toBe(1)

      upstream.restart()
      await gateway.stop('entry')
      const provider = vi.fn(upstream.mintUrlFor)
      const second = await gateway.start({ id: 'entry', kind: 'outbound', upstream: upstream.origin, port: preferred, tokenProvider: provider })
      expect(second.port).toBe(preferred)

      const replayable = await call(preferred, '/api/echo', { method: 'POST', body: 'x' })
      expect(replayable.status).toBe(200)
      expect(provider).toHaveBeenCalledTimes(1)
      expect(upstream.mintCount).toBe(2)
    })
  })

  it('入站与隧道腿剥离上游 set-cookie 但照常下发网关切身签发的会话 cookie，出站腿保留上游 set-cookie', async () => {
    const inbound = await gateway.start({ id: 'inbound', kind: 'inbound', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor })
    const forwarded = await call(inbound.port, '/upstream-cookie', { headers: markerHeaders('private') })
    expect(forwarded.status).toBe(200)
    expect(forwarded.headers['set-cookie']).toBeUndefined()

    const tunnel = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const visitor = await call(tunnel.port, '/upstream-cookie', { headers: tunnelHeaders(`dsh_remote_session=${session}`) })
    expect(visitor.status).toBe(200)
    expect(JSON.stringify(visitor.headers['set-cookie'] ?? '')).not.toContain('dsh_upstream_credential')
    const login = await call(tunnel.port, '/', { headers: tunnelHeaders('', { accept: 'text/html' }) })
    expect(login.status).toBe(401)
    expect(JSON.stringify(login.headers['set-cookie'] ?? '')).not.toContain('dsh_upstream_credential')
    const granted = await call(tunnel.port, '/?auth=link-token', { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(granted.status).toBe(302)
    expect(JSON.stringify(granted.headers['set-cookie'])).toContain('dsh_remote_session=')

    const outbound = await gateway.start({ id: 'outbound', kind: 'outbound', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor })
    const local = await call(outbound.port, '/upstream-cookie')
    expect(JSON.stringify(local.headers['set-cookie'])).toContain('dsh_upstream_credential=leaked')
  })

  it('转发时把 Host 与 Origin 改写为浏览器所见的网关回环 authority', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(status.port, '/api/ping', { headers: { host: `127.0.0.1:${status.port}`, origin: `http://127.0.0.1:${status.port}` } })
    const forwarded = upstream.calls.at(-1)
    expect(forwarded?.headers.host).toBe(`127.0.0.1:${status.port}`)
    expect(forwarded?.headers.origin).toBe(`http://127.0.0.1:${status.port}`)
  })

  it('保留浏览器自带的其它 cookie，只覆盖同名的那一枚', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(status.port, '/api/ping', { headers: { cookie: 'theme=dark' } })
    expect(cookieOf(upstream.calls.at(-1)?.headers ?? {})).toMatch(new RegExp(`^theme=dark; ${cookieNameOf(`127.0.0.1:${status.port}`)}=mint-`))
  })

  it('对远端的请求声明 accept-encoding identity，且绝不出现内部来源标识', async () => {
    const status = await startEntry('outbound', upstream, {
      tokenProvider: upstream.mintUrlFor,
      host: '127.0.0.1',
    })
    await call(status.port, '/api/ping', {
      headers: { 'accept-encoding': 'zstd, gzip', [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: SESSION },
    })
    const forwarded = upstream.calls.at(-1)
    expect(forwarded?.headers['accept-encoding']).toBe('identity')
    expect(forwarded?.headers[GATEWAY_SOURCE_HEADER]).toBeUndefined()
    expect(forwarded?.headers[GATEWAY_SESSION_HEADER]).toBeUndefined()
    expect(JSON.stringify(forwarded?.headers)).not.toContain(SESSION)
  })

  it('token provider 失败时透传上游 401、记录可读事件且不缓存失败结果', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    let calls = 0
    const status = await startEntry('outbound', upstream, {
      tokenProvider: async () => {
        calls += 1
        return undefined
      },
    })
    const first = await call(status.port, '/api/ping')
    const second = await call(status.port, '/api/ping')
    unsubscribe()
    expect(first.status).toBe(401)
    expect(second.status).toBe(401)
    expect(calls).toBe(2)
    expect(events.filter(event => event.kind === 'cookie').map(event => event.line))
      .toEqual([1, 2].map(() => `DSH 原生 cookie 铸造失败（token 不可用），已透传上游响应（127.0.0.1:${status.port}）`))
    expect(JSON.stringify(events)).not.toContain(SESSION)
  })

  it('token provider 抛错时透传上游响应并记录一条可读事件', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    const status = await startEntry('outbound', upstream, {
      tokenProvider: async () => {
        throw new Error('远端实例尚未就绪')
      },
    })
    const reply = await call(status.port, '/api/ping')
    unsubscribe()
    expect(reply.status).toBe(401)
    expect(events.some(event => event.kind === 'cookie' && event.line.includes('远端实例尚未就绪'))).toBe(true)
    expect(JSON.stringify(events)).not.toContain(SESSION)
  })

  it('上游重启后失效的可重放请求在首次 401 时重铸 cookie 并重试成功', async () => {
    const provider = vi.fn(upstream.mintUrlFor)
    const status = await startEntry('outbound', upstream, { tokenProvider: provider })
    expect((await call(status.port, '/api/ping')).status).toBe(200)
    upstream.restart()
    const reply = await call(status.port, '/api/ping')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('{"ok":true}')
    expect(upstream.mintCount).toBe(2)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('失效的凭据重铸失败时透传 401，且不再发第二次上游请求', async () => {
    let failing = false
    const provider = vi.fn(async (authority: string) => failing ? undefined : await upstream.mintUrlFor(authority))
    const status = await startEntry('outbound', upstream, { tokenProvider: provider })
    expect((await call(status.port, '/api/ping')).status).toBe(200)
    expect(provider).toHaveBeenCalledTimes(1)
    failing = true
    upstream.restart()
    const before = upstream.calls.length
    const reply = await call(status.port, '/api/echo', { method: 'POST', headers: { 'content-length': '0' } })
    expect(reply.status).toBe(401)
    expect(provider).toHaveBeenCalledTimes(2)
    const attempts = upstream.calls.slice(before)
    expect(attempts).toHaveLength(1)
    expect(attempts.map(entry => entry.method)).toEqual(['POST'])
    expect(grantedCookieOf(attempts[0]?.headers ?? {})).toMatch(/^mint-/)
  })

  it('已发出请求体的请求遇到 401 时直接透传，不重试', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(status.port, '/api/ping')
    const mints = upstream.mintCount
    upstream.restart()
    const reply = await call(status.port, '/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'payload' })
    expect(reply.status).toBe(401)
    expect(upstream.mintCount).toBe(mints)
  })

  it('上游不可达时返回 502 与含上游地址的可读原因', async () => {
    const dead = await freePort()
    const port = dead.port
    await dead.release()
    const status = await gateway.start({ id: 'entry', kind: 'outbound', upstream: `http://127.0.0.1:${port}`, port: 0 })
    const reply = await call(status.port, '/api/ping')
    expect(reply.status).toBe(502)
    expect(JSON.parse(reply.body.toString()).error).toContain(`http://127.0.0.1:${port}`)
  })

  it('上游迟迟不响应时按短超时返回 504', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
      const pending = call(status.port, '/stall')
      await upstream.waitForCall('/stall')
      vi.advanceTimersByTime(30_001)
      const reply = await pending
      expect(reply.status).toBe(504)
      expect(JSON.parse(reply.body.toString()).error).toContain(`http://127.0.0.1:${upstream.port}`)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('流式转发大请求体，不整体缓冲', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const payload = Buffer.alloc(3 * 1024 * 1024, 3)
    const reply = await call(status.port, '/api/echo', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body.toString())).toEqual({ received: payload.length })
  })

  it('原样透传指向回环地址的重定向', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await call(status.port, '/redirect')
    expect(reply.status).toBe(302)
    expect(reply.headers.location).toBe(`http://127.0.0.1:${upstream.port}/`)
  })
})

describe('gateway 转发请求的正文分帧（裸上游字节断言）', () => {
  it('转发带分块正文的读类请求时重新分块写出：已解码的正文绝不以第二个请求的形态落在上游连接上', async () => {
    const raw = await rawUpstream()
    const status = await gateway.start({ id: 'entry', kind: 'outbound', upstream: raw.origin, port: 0, tokenProvider: async authority => `http://${authority}/?token=launch-token-1` })
    try {
      const payload = 'GET /smuggled HTTP/1.1\r\nhost: 127.0.0.1:1\r\n\r\n'
      const body = `5\r\nhello\r\n0\r\n\r\n${payload}`
      const reply = await call(status.port, '/x', { method: 'GET', headers: { 'transfer-encoding': 'chunked' }, body })
      expect(reply.status).toBe(200)
      const forwarded = (await raw.waitForRequests(2)).at(-1) ?? ''
      const head = headOf(forwarded)
      const wire = bodyOf(forwarded)
      expect(head.split('\r\n')[0]).toBe('GET /x HTTP/1.1')
      expect(head.toLowerCase()).toContain('transfer-encoding: chunked')
      expect(head.toLowerCase()).not.toContain('content-length')
      expect(wire.endsWith('0\r\n\r\n')).toBe(true)
      expect(decodeChunked(wire)).toBe(body)
      expect(wire.startsWith('\r\nGET /smuggled')).toBe(false)
      expect(wire.startsWith('GET /smuggled')).toBe(false)
    }
    finally {
      await gateway.stop('entry')
      await raw.close()
    }
  })

  it('转发带分块正文的写类请求时同样按上游声明的分块写出，逐块字节可校验', async () => {
    const raw = await rawUpstream()
    const status = await gateway.start({ id: 'entry', kind: 'outbound', upstream: raw.origin, port: 0, tokenProvider: async authority => `http://${authority}/?token=launch-token-1` })
    try {
      const reply = await call(status.port, '/x', { method: 'POST', headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }, body: 'hello' })
      expect(reply.status).toBe(200)
      const forwarded = (await raw.waitForRequests(2)).at(-1) ?? ''
      expect(headOf(forwarded).toLowerCase()).toContain('transfer-encoding: chunked')
      expect(bodyOf(forwarded)).toBe('5\r\nhello\r\n0\r\n\r\n')
    }
    finally {
      await gateway.stop('entry')
      await raw.close()
    }
  })

  it('客户端声明 content-length 时按同一长度写出，上游连接上的正文长度与声明一致', async () => {
    const raw = await rawUpstream()
    const status = await gateway.start({ id: 'entry', kind: 'outbound', upstream: raw.origin, port: 0, tokenProvider: async authority => `http://${authority}/?token=launch-token-1` })
    try {
      const payload = 'GET /smuggled HTTP/1.1\r\nhost: 127.0.0.1:1\r\n\r\n'
      const reply = await call(status.port, '/x', { method: 'GET', headers: { 'content-length': String(Buffer.byteLength(payload)) }, body: payload })
      expect(reply.status).toBe(200)
      const forwarded = (await raw.waitForRequests(2)).at(-1) ?? ''
      const head = headOf(forwarded)
      expect(head.toLowerCase()).toContain(`content-length: ${Buffer.byteLength(payload)}`)
      expect(head.toLowerCase()).not.toContain('transfer-encoding')
      expect(bodyOf(forwarded)).toBe(payload)
    }
    finally {
      await gateway.stop('entry')
      await raw.close()
    }
  })

  it('无正文声明的请求不凭空添上分帧头，也不写出任何正文', async () => {
    const raw = await rawUpstream()
    const status = await gateway.start({ id: 'entry', kind: 'outbound', upstream: raw.origin, port: 0, tokenProvider: async authority => `http://${authority}/?token=launch-token-1` })
    try {
      const reply = await call(status.port, '/x')
      expect(reply.status).toBe(200)
      const forwarded = (await raw.waitForRequests(2)).at(-1) ?? ''
      const head = headOf(forwarded)
      expect(head.toLowerCase()).not.toContain('transfer-encoding')
      expect(head.toLowerCase()).not.toContain('content-length')
      expect(bodyOf(forwarded)).toBe('')
    }
    finally {
      await gateway.stop('entry')
      await raw.close()
    }
  })
})

describe('gateway 来源门禁判定矩阵（真实 HTTP 管线）', () => {
  const CLASSES = ['loopback', 'private', 'public', 'tunnel'] as const

  function headersFor(source: typeof CLASSES[number]): IncomingHttpHeaders {
    return source === 'loopback' ? {} : markerHeaders(source)
  }

  function policyFor(mode: 'unconfigured' | 'public_only' | 'all'): (() => RemoteAuthPolicy) | undefined {
    if (mode === 'unconfigured')
      return undefined
    return () => policyOf({ scope: mode, linkToken: 'link-token' })
  }

  const EXPECTED: Record<typeof CLASSES[number], { unconfigured: number, publicOnly: number, all: number }> = {
    loopback: { unconfigured: 200, publicOnly: 200, all: 200 },
    private: { unconfigured: 200, publicOnly: 200, all: 401 },
    public: { unconfigured: 403, publicOnly: 401, all: 401 },
    tunnel: { unconfigured: 403, publicOnly: 401, all: 401 },
  }

  for (const source of CLASSES) {
    for (const mode of ['unconfigured', 'public_only', 'all'] as const) {
      const expected = mode === 'unconfigured' ? EXPECTED[source].unconfigured : mode === 'public_only' ? EXPECTED[source].publicOnly : EXPECTED[source].all
      it(`【矩阵】${source} × ${mode} 的表现是 ${expected}`, async () => {
        const status = await gateway.start({
          id: 'entry',
          kind: 'inbound',
          upstream: upstream.origin,
          port: 0,
          tokenProvider: upstream.mintUrlFor,
          ...policyFor(mode) === undefined ? {} : { auth: policyFor(mode) },
        })
        const reply = await call(status.port, '/api/ping', { headers: headersFor(source) })
        expect(reply.status).toBe(expected)
      })
    }
  }

  it('把物理回环来源之外的私网来源按真实 TCP 对端地址判定', async () => {
    const external = externalAddress()
    if (external === undefined)
      throw new Error('本机不存在非内部 IPv4 地址，无法断言真实私网来源')
    const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0, host: '0.0.0.0', auth: () => policyOf({ scope: 'all' }) })
    const reply = await new Promise<Coded>((resolve, reject) => {
      const request = httpRequest({ host: external, port: status.port, path: '/api/ping', headers: { connection: 'close' } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      })
      request.on('error', reject)
      request.end()
    })
    expect(reply.status).toBe(401)
  })

  it('未配置认证时的导航请求得到引导页面而非空白拒绝', async () => {
    const status = await startEntry('inbound', upstream)
    const reply = await call(status.port, '/api/ping', { headers: markerHeaders('public', navigation()) })
    expect(reply.status).toBe(403)
    expect(reply.headers['content-type']).toContain('text/html')
    expect(reply.body.toString()).toContain('访问被拒绝')
  })

  it('认证存储损坏时视为未配置认证，公网与隧道来源被拒绝并引导重设密码', async () => {
    const corrupt: RemotePasswordRecord = { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 1000, hash: 'aGFzaA==' }
    const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ password: corrupt }) })
    const page = await call(status.port, '/api/ping', { headers: markerHeaders('public', navigation()) })
    expect(page.status).toBe(403)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body.toString()).toContain('重新设置访问密码')

    const api = await call(status.port, '/api/ping', { headers: markerHeaders('tunnel') })
    expect(api.status).toBe(403)
    expect(JSON.parse(api.body.toString()).error).toContain('认证存储损坏')

    await expect(upgraded(status.port, '/api/remote.mux', markerHeaders('tunnel'))).rejects.toThrow('403')

    const loopback = await call(status.port, '/api/ping')
    expect(loopback.status).toBe(200)
  })

  it('认证存储损坏但有链接 Token 时仍按需认证处理', async () => {
    const corrupt: RemotePasswordRecord = { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 1000, hash: 'aGFzaA==' }
    const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ password: corrupt, linkToken: 'link-token' }) })
    const visitor = await call(status.port, '/?auth=link-token', { headers: markerHeaders('tunnel', navigation()) })
    expect(visitor.status).toBe(302)
    expect(String(visitor.headers['set-cookie'])).toContain('dsh_remote_session=')
  })

  it('需认证的导航请求得到内置登录页，API 请求得到 401 与可读错误体', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const page = await call(status.port, '/', { headers: markerHeaders('public', navigation()) })
    expect(page.status).toBe(401)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.body.toString()).toContain('<form method="post">')

    const api = await call(status.port, '/api/ping', { headers: markerHeaders('public') })
    expect(api.status).toBe(401)
    expect(JSON.parse(api.body.toString()).error).toBe('需要认证后才能访问。')
  })
})

describe('gateway 跨站来源拦截', () => {
  it('跨站 Origin 的请求被拒绝，绝不把外部 Origin 洗成回环 authority', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await call(status.port, '/api/ping', { headers: { origin: 'https://evil.example' } })
    expect(reply.status).toBe(403)
    expect(reply.body.toString()).toContain('跨站来源')
    expect(upstream.calls).toHaveLength(0)
  })

  it('sec-Fetch-Site 为 cross-site 时即使 Origin 缺失也被拒绝', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await call(status.port, '/api/ping', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })
    expect(reply.status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })

  it('跨站的文档导航照旧放行，落地文档随即同源（壳层 iframe 与外站链接依赖它）', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await call(status.port, '/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', ...navigation() } })
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toContain('<html>')
    expect(upstream.calls.at(-1)?.url).toBe('/')
  })

  it('同源 Origin 与隧道域名形式的 Host 都照旧放行并改写为回环 authority', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const same = await call(status.port, '/api/ping', { headers: { host: `127.0.0.1:${status.port}`, origin: `http://127.0.0.1:${status.port}` } })
    expect(same.status).toBe(200)

    const tunnel = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const visitor = await call(tunnel.port, '/api/ping', {
      headers: { 'host': 's2-probe.trycloudflare.com', 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin', 'cookie': `dsh_remote_session=${session}` },
    })
    expect(visitor.status).toBe(200)
    expect(upstream.calls.at(-1)?.headers.origin).toBe(upstream.origin)
  })

  it('跨站页面的 WebSocket 升级被拒绝且不触达上游', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await expect(upgraded(status.port, '/api/remote.mux', { origin: 'https://evil.example' })).rejects.toThrow('403')
    expect(upstream.upgrades).toHaveLength(0)
    const same = await upgraded(status.port, '/api/remote.mux', { origin: `http://127.0.0.1:${status.port}` })
    expect(same.status).toBe(101)
    same.socket.destroy()
  })

  it('隧道腿在 Host 被 cloudflared 改写成回环 authority 后照旧放行（含全部 WebSocket 升级）', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const rewritten = { 'host': `127.0.0.1:${status.port}`, 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'cookie': `dsh_remote_session=${session}` }
    const api = await call(status.port, '/api/ping', { headers: rewritten })
    expect(api.status).toBe(200)
    expect(upstream.calls.at(-1)?.headers.origin).toBe(upstream.origin)

    const live = await upgraded(status.port, '/api/remote.mux', rewritten)
    expect(live.status).toBe(101)
    const greeting = await once(live.socket, 'data')
    expect((greeting[0] as Buffer).toString()).toBe('echo:hello')
    live.socket.destroy()
  })

  it('隧道腿 Host 被改写时只信 same-origin / none，same-site 的带凭据请求被拒绝', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const base = { host: `127.0.0.1:${status.port}`, origin: 'https://evil.trycloudflare.com', cookie: `dsh_remote_session=${session}` }
    const sameSite = await call(status.port, '/api/ping', { headers: { ...base, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } })
    expect(sameSite.status).toBe(403)
    expect(sameSite.body.toString()).toContain('跨站来源')
    const headerless = await call(status.port, '/api/ping', { headers: base })
    expect(headerless.status).toBe(403)
    await expect(upgraded(status.port, '/api/remote.mux', { ...base, 'sec-fetch-site': 'same-site' })).rejects.toThrow('403')
    expect(upstream.calls).toHaveLength(0)
    expect(upstream.upgrades).toHaveLength(0)
  })

  it('隧道腿 Host 被改写时 same-origin / none 与文档导航照旧放行', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const cookie = `dsh_remote_session=${session}`
    const sameOrigin = await call(status.port, '/api/ping', { headers: { 'host': `127.0.0.1:${status.port}`, 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie } })
    expect(sameOrigin.status).toBe(200)
    const direct = await call(status.port, '/api/ping', { headers: { 'host': `127.0.0.1:${status.port}`, 'sec-fetch-site': 'none', cookie } })
    expect(direct.status).toBe(200)
    const navigationRequest = await call(status.port, '/', { headers: { 'host': `127.0.0.1:${status.port}`, 'origin': 'https://evil.trycloudflare.com', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', ...navigation(), cookie } })
    expect(navigationRequest.status).toBe(200)
  })

  it('隧道腿的隧道域名 Host 与 Origin 不一致时仍按跨站拒绝', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const reply = await call(status.port, '/api/ping', {
      headers: { 'host': 's2-probe.trycloudflare.com', 'origin': 'https://evil.example', 'sec-fetch-site': 'same-origin', 'cookie': `dsh_remote_session=${session}` },
    })
    expect(reply.status).toBe(403)
    expect(reply.body.toString()).toContain('跨站来源')
    await expect(upgraded(status.port, '/api/remote.mux', { host: 's2-probe.trycloudflare.com', origin: 'https://evil.example', cookie: `dsh_remote_session=${session}` })).rejects.toThrow('403')
    expect(upstream.upgrades).toHaveLength(0)
  })
})

describe('gateway 认证要素', () => {
  it('密码登录成功后签发会话并 302 回跳原始访问路径', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }), tokenProvider: upstream.mintUrlFor })
    const login = await call(status.port, '/chat/42', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', ...navigation() }),
      body: 'password=s3cret',
    })
    expect(login.status).toBe(302)
    expect(login.headers.location).toBe('/chat/42')
    expect(login.headers['cache-control']).toBe('no-store')
    expect(login.headers['referrer-policy']).toBe('no-referrer')
    const cookie = (login.headers['set-cookie'] ?? [])[0] ?? ''
    expect(cookie).toContain('HttpOnly')
    const session = cookie.slice('dsh_remote_session='.length).split(';')[0] ?? ''
    expect(verifySession(session, 'session-secret', Date.now())).toBe(true)

    const forwarded = await call(status.port, '/api/ping', { headers: markerHeaders('public', { cookie: `dsh_remote_session=${session}` }) })
    expect(forwarded.status).toBe(200)
  })

  it('登录页表单提交到当前 URL：回跳目标不依赖 Referer（登录页声明 no-referrer）', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }), tokenProvider: upstream.mintUrlFor })
    const page = await call(status.port, '/chat/42?tab=two', { headers: markerHeaders('public', navigation()) })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('<form method="post">')
    const login = await call(status.port, '/chat/42?tab=two', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', ...navigation() }),
      body: 'password=s3cret',
    })
    expect(login.headers.referer).toBeUndefined()
    expect(login.status).toBe(302)
    expect(login.headers.location).toBe('/chat/42?tab=two')
  })

  it('aPI 客户端带 password 字段的 POST 不是登录提交：回 401 且不误发会话', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const shaped = await call(status.port, '/api/echo', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' }),
      body: 'password=s3cret',
    })
    expect(shaped.status).toBe(401)
    expect(shaped.headers['set-cookie']).toBeUndefined()
    expect(JSON.parse(shaped.body.toString()).error).toBe('需要认证后才能访问。')

    const notUrlencoded = await call(status.port, '/api/echo', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/json', ...navigation() }),
      body: '{"password":"s3cret"}',
    })
    expect(notUrlencoded.status).toBe(401)
    expect(notUrlencoded.headers['set-cookie']).toBeUndefined()
    expect(upstream.calls.some(entry => entry.url === '/api/echo')).toBe(false)
  })

  it('密码错误时重新渲染登录页并计入限速，连续失败触发封禁', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const attempt = async () => await call(status.port, '/', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', ...navigation() }),
      body: 'password=wrong',
    })
    const first = await attempt()
    expect(first.status).toBe(401)
    expect(first.body.toString()).toContain('密码不正确')
    for (let index = 1; index < 5; index++)
      await attempt()
    const banned = await attempt()
    expect(banned.status).toBe(429)
    expect(banned.headers['retry-after']).toBeDefined()
    expect(banned.body.toString()).toContain('认证失败次数过多')
  })

  it('链接 Token 命中即签发会话并 302 到不带参数的干净 URL', async () => {
    const token = createLinkToken()
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: token }), tokenProvider: upstream.mintUrlFor })
    const hit = await call(status.port, `/?auth=${token}`, { headers: markerHeaders('public') })
    expect(hit.status).toBe(302)
    expect(hit.headers.location).toBe('/')
    const session = ((hit.headers['set-cookie'] ?? [])[0] ?? '').slice('dsh_remote_session='.length).split(';')[0] ?? ''
    expect(verifySession(session, 'session-secret', Date.now())).toBe(true)

    const rotated = await call(status.port, '/?auth=stale-token', { headers: markerHeaders('public') })
    expect(rotated.status).toBe(401)
  })

  it('会话 cookie 伪造或过期都不放行', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const forged = await call(status.port, '/api/ping', { headers: markerHeaders('public', { cookie: 'dsh_remote_session=v1.9999999999999.deadbeef' }) })
    expect(forged.status).toBe(401)
    const expired = signSession('session-secret', Date.now() - 60_000, 1000)
    const stale = await call(status.port, '/api/ping', { headers: markerHeaders('public', { cookie: `dsh_remote_session=${expired.value}` }) })
    expect(stale.status).toBe(401)
  })
})

describe('gateway 内部来源标识', () => {
  it('把分类与会话标识注入到本机上游，隧道入口恒定声明 tunnel', async () => {
    const inbound = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(inbound.port, '/api/ping', { headers: markerHeaders('private') })
    expect(upstream.calls.at(-1)?.headers[GATEWAY_SOURCE_HEADER]).toBe('private')
    expect(upstream.calls.at(-1)?.headers[GATEWAY_SESSION_HEADER]).toBe(SESSION)

    const tunnel = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const forwarded = await call(tunnel.port, '/api/ping', { headers: tunnelHeaders(`dsh_remote_session=${session}`) })
    expect(forwarded.status).toBe(200)
    expect(upstream.calls.at(-1)?.headers[GATEWAY_SOURCE_HEADER]).toBe('tunnel')
  })

  it('注入前先剥离客户端自带的标识头，绝不追加成多值头', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const session = signSession('session-secret', Date.now()).value
    const reply = await call(status.port, '/api/ping', {
      headers: tunnelHeaders(`dsh_remote_session=${session}`, {
        [GATEWAY_SOURCE_HEADER]: ['loopback', 'private'],
        [GATEWAY_SESSION_HEADER]: ['forged', 'forged'],
      }),
    })
    expect(reply.status).toBe(200)
    const forwarded = upstream.calls.at(-1)?.headers ?? {}
    expect(forwarded[GATEWAY_SOURCE_HEADER]).toBe('tunnel')
    expect(forwarded[GATEWAY_SESSION_HEADER]).toBe(SESSION)
  })

  it('会话标识不匹配或缺失时按不可信处理，不回退到回环判定', async () => {
    const status = await startEntry('inbound', upstream)
    const forged = await call(status.port, '/api/ping', { headers: { [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: 'forged' } })
    expect(forged.status).toBe(403)
    const half = await call(status.port, '/api/ping', { headers: { [GATEWAY_SOURCE_HEADER]: 'loopback' } })
    expect(half.status).toBe(403)
    expect(upstream.calls.some(entry => entry.url === '/api/ping')).toBe(false)
  })

  it('会话标识不出现在任何事件里', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await call(status.port, '/api/ping', { headers: markerHeaders('private') })
    await call(status.port, '/api/ping', { headers: markerHeaders('public') })
    await call(status.port, '/api/ping', { headers: { [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: 'forged' } })
    unsubscribe()
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(SESSION)
  })

  it('会话标识不出现在任何响应里', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const replies = [
      await call(status.port, '/api/ping', { headers: markerHeaders('private') }),
      await call(status.port, '/api/ping', { headers: markerHeaders('public') }),
      await call(status.port, '/', { headers: markerHeaders('public', { accept: '*/*' }) }),
    ]
    for (const reply of replies) {
      expect(reply.body.toString()).not.toContain(SESSION)
      expect(JSON.stringify(reply.headers)).not.toContain(SESSION)
    }
  })

  it('会话标识不出现在出站到远端机器的请求里', async () => {
    const outbound = await gateway.start({ id: 'outbound', kind: 'outbound', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor })
    await call(outbound.port, '/api/ping', { headers: { [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: SESSION } })
    const forwarded = upstream.calls.filter(entry => entry.headers.host === `127.0.0.1:${outbound.port}`)
    expect(forwarded.length).toBeGreaterThan(0)
    expect(JSON.stringify(forwarded)).not.toContain(SESSION)
  })

  it('隧道与管理入口只监听回环，入站才按调用方给定的地址', async () => {
    const tunnel = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, host: '0.0.0.0' })
    const outbound = await gateway.start({ id: 'outbound', kind: 'outbound', upstream: upstream.origin, port: 0, host: '0.0.0.0' })
    const inbound = await gateway.start({ id: 'inbound', kind: 'inbound', upstream: upstream.origin, port: 0, host: '0.0.0.0' })
    expect(tunnel.host).toBe('127.0.0.1')
    expect(outbound.host).toBe('127.0.0.1')
    expect(inbound.host).toBe('0.0.0.0')
  })
})

describe('gateway 限速分桶', () => {
  it('隧道来源按隧道侧声明的客户端 IP 分桶，一个访客锁不死其它访客', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, auth: () => policyOf({ linkToken: 'link-token' }) })
    const attempt = async (clientIp: string) => await call(status.port, '/', {
      method: 'POST',
      headers: { 'cf-connecting-ip': clientIp, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...navigation() },
      body: 'password=wrong',
    })
    for (let index = 0; index < 5; index++)
      await attempt('203.0.113.7')
    const banned = await attempt('203.0.113.7')
    expect(banned.status).toBe(429)
    const other = await attempt('198.51.100.9')
    expect(other.status).toBe(401)
  })

  it('非隧道来源忽略可伪造的转发头，只按 TCP 对端分桶', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const attempt = async (clientIp: string) => await call(status.port, '/', {
      method: 'POST',
      headers: markerHeaders('public', { 'cf-connecting-ip': clientIp, 'content-type': 'application/x-www-form-urlencoded', ...navigation() }),
      body: 'password=wrong',
    })
    for (let index = 0; index < 5; index++)
      await attempt('203.0.113.7')
    const banned = await attempt('198.51.100.9')
    expect(banned.status).toBe(429)
  })

  it('同一分桶被封禁后，持有效会话的访客仍被放行', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor, auth: () => policyOf({ linkToken: 'link-token' }) })
    const attempt = async () => await call(status.port, '/', {
      method: 'POST',
      headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', ...navigation() }),
      body: 'password=wrong',
    })
    for (let index = 0; index < 6; index++)
      await attempt()
    const banned = await attempt()
    expect(banned.status).toBe(429)

    const session = signSession('session-secret', Date.now()).value
    const admitted = await call(status.port, '/api/ping', { headers: markerHeaders('public', { cookie: `dsh_remote_session=${session}` }) })
    expect(admitted.status).toBe(200)
  })
})

describe('gateway 压缩协商', () => {
  async function compressedEntry(): Promise<number> {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    return status.port
  }

  it('客户端声明 zstd 时返回 zstd，只声明 gzip 时返回 gzip，都不声明时返回 identity', async () => {
    const port = await compressedEntry()
    const zstd = await call(port, '/big', { headers: markerHeaders('private', { 'accept-encoding': 'zstd, gzip' }) })
    expect(zstd.headers['content-encoding']).toBe('zstd')
    expect(zstd.headers.vary).toBe('accept-encoding')
    expect(decodeReply(zstd)).toBe('b'.repeat(MIN_BYTES * 4))

    const gzip = await call(port, '/big', { headers: markerHeaders('private', { 'accept-encoding': 'gzip' }) })
    expect(gzip.headers['content-encoding']).toBe('gzip')
    expect(decodeReply(gzip)).toBe('b'.repeat(MIN_BYTES * 4))

    const plain = await call(port, '/big', { headers: markerHeaders('private') })
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString()).toBe('b'.repeat(MIN_BYTES * 4))
  })

  it('只接受 br 时走 identity 而不报错', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/big', { headers: markerHeaders('private', { 'accept-encoding': 'br' }) })
    expect(reply.status).toBe(200)
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(reply.body.toString()).toBe('b'.repeat(MIN_BYTES * 4))
  })

  it('小于阈值的响应不被压缩', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/small', { headers: markerHeaders('private', { 'accept-encoding': 'zstd' }) })
    expect(reply.status).toBe(200)
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(reply.body.toString()).toBe('tiny')
  })

  it('未知长度的小响应在未达阈值时按 identity 结束，不留下声明了编码的明文正文', async () => {
    const port = await compressedEntry()
    for (const coding of ['zstd', 'gzip'] as const) {
      const reply = await call(port, '/chunked-small', { headers: markerHeaders('private', { 'accept-encoding': coding }) })
      expect(reply.status).toBe(200)
      expect(reply.headers['content-encoding']).toBeUndefined()
      expect(reply.headers['content-length']).toBe(String(reply.body.length))
      expect(reply.body.toString()).toBe('{"ok":true}')
    }
  })

  it('不可压缩类型不被压缩', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/image', { headers: markerHeaders('private', { 'accept-encoding': 'zstd' }) })
    expect(reply.status).toBe(200)
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(reply.body.length).toBe(MIN_BYTES * 2)
  })

  it('未知长度的大响应在达到阈值后才开始压缩', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/chunked', { headers: markerHeaders('private', { 'accept-encoding': 'zstd' }) })
    expect(reply.headers['content-encoding']).toBe('zstd')
    expect(reply.headers['content-length']).toBeUndefined()
    expect(decodeReply(reply)).toBe(`${'c'.repeat(MIN_BYTES)}${'d'.repeat(MIN_BYTES)}`)
  })

  it('上游已 gzip 而客户端只接受 zstd 时解压后按 zstd 重压并重算长度', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/gz', { headers: markerHeaders('private', { 'accept-encoding': 'zstd' }) })
    expect(reply.headers['content-encoding']).toBe('zstd')
    expect(reply.headers['content-length']).toBeUndefined()
    expect(decodeReply(reply)).toBe('g'.repeat(MIN_BYTES * 2))
  })

  it('上游编码在下游可接受集合内时原样透传，不做二次压缩', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/gz', { headers: markerHeaders('private', { 'accept-encoding': 'gzip' }) })
    expect(reply.headers['content-encoding']).toBe('gzip')
    expect(reply.headers['content-length']).toBe(String(reply.body.length))
    expect(zlib.gunzipSync(reply.body).toString()).toBe('g'.repeat(MIN_BYTES * 2))
  })

  it('本地回环腿一律 identity，即使客户端声明了 zstd', async () => {
    const port = await compressedEntry()
    const reply = await call(port, '/big', { headers: { 'accept-encoding': 'zstd' } })
    expect(reply.status).toBe(200)
    expect(reply.headers['content-encoding']).toBeUndefined()
    expect(reply.body.toString()).toBe('b'.repeat(MIN_BYTES * 4))
  })
})

describe('gateway SSE 流式压缩', () => {
  it('逐块 flush：第二个分片尚未写出时第一个分片已经到达', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await streamed(status.port, '/sse', markerHeaders('private', { 'accept-encoding': 'zstd' }))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-encoding']).toBe('zstd')
    expect(reply.headers['content-length']).toBeUndefined()

    const decoded = reply.stream.pipe(zlib.createZstdDecompress())
    let text = ''
    decoded.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    await vi.waitFor(() => expect(text).toContain('data: one'))
    expect(text).not.toContain('data: two')
    upstream.releaseEvents()
    await vi.waitFor(() => expect(text).toContain('data: two'))
  })

  it('只接受 gzip 的客户端同样得到逐块到达的 SSE', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await streamed(status.port, '/sse', markerHeaders('private', { 'accept-encoding': 'gzip' }))
    expect(reply.headers['content-encoding']).toBe('gzip')
    const decoded = reply.stream.pipe(zlib.createGunzip())
    let text = ''
    decoded.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    await vi.waitFor(() => expect(text).toContain('data: one'))
    expect(text).not.toContain('data: two')
    upstream.releaseEvents()
    await vi.waitFor(() => expect(text).toContain('data: two'))
  })
})

describe('gateway 流中断与泄漏防护', () => {
  it('sSE 中途断开时终止压缩流并结束响应，不残留连接', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const live = await streamed(status.port, '/sse', markerHeaders('private', { 'accept-encoding': 'zstd' }))
    expect(live.status).toBe(200)
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(1))
    live.stream.destroy()
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
    const after = await call(status.port, '/api/ping', { headers: markerHeaders('private') })
    expect(after.status).toBe(200)
  })

  it('关闭入口后端口立即可被重新占用', async () => {
    const free = await freePort()
    const preferred = free.port
    await free.release()
    await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: preferred })
    await gateway.stop('entry')
    const reused = await freePortAt(preferred)
    expect(reused, '关闭后端口应无残留占用').toBeDefined()
    await reused?.release()
  })
})

describe('gateway 上游响应中途断流', () => {
  it('未知长度且已达阈值：终止该响应，不把客户端永久挂起', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const outcome = await observed(status.port, '/abort-big', markerHeaders('private', { 'accept-encoding': 'zstd' }))
    expect(outcome.kind).not.toBe('no-response')
    expect(outcome.bodyLength).toBeLessThan(MIN_BYTES * 4)
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
  })

  it('未知长度且未达阈值：回可读 502，而不是伪装成完整的 200', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const outcome = await observed(status.port, '/abort-small', markerHeaders('private', { 'accept-encoding': 'zstd' }), 3000)
    expect(outcome.kind).toBe('end')
    expect(outcome.status).toBe(502)
    expect(outcome.bodyLength).toBeGreaterThan(0)
  })

  it('上游断流只影响该条响应，记录事件且连接不残留', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    await observed(status.port, '/abort-small', markerHeaders('private', { 'accept-encoding': 'zstd' }), 3000)
    unsubscribe()
    expect(events.some(event => event.kind === 'compression' && event.line.includes('上游响应流错误'))).toBe(true)
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
    const after = await call(status.port, '/api/ping', { headers: markerHeaders('private') })
    expect(after.status).toBe(200)
  })

  it('上游已 gzip 而下游只接受 zstd：中途断流被终止并记录，不永久挂起', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
      const outcome = await observed(status.port, '/gz-abort', markerHeaders('private', { 'accept-encoding': 'zstd' }), 3000)
      expect(outcome.kind).not.toBe('no-response')
      expect(outcome.bodyLength).toBeLessThan(MIN_BYTES * 4)
      await vi.waitFor(() => expect(events.some(event => event.kind === 'compression' && event.line.includes('响应流中断'))).toBe(true))
      await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
      const after = await call(status.port, '/api/ping', { headers: markerHeaders('private') })
      expect(after.status).toBe(200)
    }
    finally {
      unsubscribe()
    }
  })

  it('上游已 gzip 的 SSE 中途断流：终止压缩流并结束响应，不残留监听', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
      const outcome = await observed(status.port, '/gz-sse-abort', markerHeaders('private', { 'accept-encoding': 'zstd' }), 3000)
      expect(outcome.kind).not.toBe('no-response')
      await vi.waitFor(() => expect(events.some(event => event.kind === 'compression' && event.line.includes('响应流中断'))).toBe(true))
      await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
    }
    finally {
      unsubscribe()
    }
  })
})

describe('gateway 处理失败边界', () => {
  it('登录请求体被客户端中途掐断时不产生未捕获拒绝，也不触达上游', async () => {
    const status = await startEntry('inbound', upstream, { auth: () => policyOf({ linkToken: 'link-token' }) })
    const rejections: string[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(String(reason))
    }
    process.on('unhandledRejection', onRejection)
    try {
      await new Promise<void>((resolve) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port: status.port,
          path: '/',
          method: 'POST',
          headers: markerHeaders('public', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '4096', 'connection': 'close', ...navigation() }),
        })
        request.on('error', () => resolve())
        request.on('response', (response) => {
          response.resume()
          response.on('end', () => resolve())
          response.on('aborted', () => resolve())
        })
        request.write('password=s3c')
        setTimeout(() => {
          request.destroy()
          resolve()
        }, 100)
      })
      // unhandledRejection 在 promise 链落到事件循环下一轮后才触发，这里只做一次固定观察窗口；
      // 用 vi.waitFor 会立即读出空数组而失去意义，因此保留真实等待。
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections).toEqual([])
    expect(upstream.calls).toHaveLength(0)
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
  })

  it('订阅者抛错不影响转发，也不打挂宿主', async () => {
    const unsubscribe = gateway.subscribe(() => {
      throw new Error('消费者故障')
    })
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
      const reply = await call(status.port, '/api/ping', { headers: markerHeaders('private') })
      expect(reply.status).toBe(200)
    }
    finally {
      unsubscribe()
    }
  })
})

describe('gateway Upgrade 例外', () => {
  it('升级请求不做压缩，但改写与注入照旧生效', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await upgraded(status.port, '/api/remote.mux', markerHeaders('private', { origin: `http://127.0.0.1:${status.port}` }))
    expect(reply.status).toBe(101)
    expect(reply.headers['content-encoding']).toBeUndefined()
    const seen = upstream.upgrades.at(-1)
    expect(seen?.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    expect(seen?.headers.origin).toBe(`http://127.0.0.1:${upstream.port}`)
    expect(grantedCookieOf(seen?.headers ?? {})).toMatch(/^mint-/)
    expect(seen?.headers[GATEWAY_SOURCE_HEADER]).toBe('private')
    expect(seen?.headers[GATEWAY_SESSION_HEADER]).toBe(SESSION)

    const greeting = await once(reply.socket, 'data')
    expect((greeting[0] as Buffer).toString()).toBe('echo:hello')
    reply.socket.write('ping')
    const echoed = await once(reply.socket, 'data')
    expect((echoed[0] as Buffer).toString()).toBe('echo:ping')
    reply.socket.destroy()
  })

  it('出站腿升级照旧改写与注入：上游收到对齐后的 host/origin、铸造 cookie 与 identity，且不带内部标识与会话', async () => {
    const status = await startEntry('outbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await upgraded(status.port, '/api/remote.mux', {
      'origin': `http://127.0.0.1:${status.port}`,
      'accept-encoding': 'zstd, gzip',
      [GATEWAY_SOURCE_HEADER]: 'loopback',
      [GATEWAY_SESSION_HEADER]: SESSION,
    })
    expect(reply.status).toBe(101)
    const seen = upstream.upgrades.at(-1)
    expect(seen?.headers.host).toBe(`127.0.0.1:${status.port}`)
    expect(seen?.headers.origin).toBe(`http://127.0.0.1:${status.port}`)
    expect(grantedCookieOf(seen?.headers ?? {})).toMatch(/^mint-/)
    expect(seen?.headers['accept-encoding']).toBe('identity')
    expect(seen?.headers[GATEWAY_SOURCE_HEADER]).toBeUndefined()
    expect(seen?.headers[GATEWAY_SESSION_HEADER]).toBeUndefined()
    expect(JSON.stringify(seen?.headers ?? {})).not.toContain(SESSION)

    const greeting = await once(reply.socket, 'data')
    expect((greeting[0] as Buffer).toString()).toBe('echo:hello')
    reply.socket.destroy()
  })

  it('关闭入口时在途的升级长连接被终止', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await upgraded(status.port, '/api/remote.mux', markerHeaders('private'))
    expect(reply.status).toBe(101)
    const terminated = new Promise<string>((resolve) => {
      reply.socket.on('close', () => resolve('closed'))
      reply.socket.on('error', () => resolve('closed'))
      reply.socket.resume()
    })
    const started = Date.now()
    await gateway.stop('entry')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await terminated).toBe('closed')
    expect(gateway.status('entry')).toMatchObject({ state: 'stopped', connections: 0 })
  })

  it('升级连接被客户端强行中断后网关仍然可用', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const reply = await upgraded(status.port, '/api/remote.mux', markerHeaders('private'))
    expect(reply.status).toBe(101)
    reply.socket.destroy()
    await vi.waitFor(() => expect(gateway.status('entry')?.connections).toBe(0))
    const after = await call(status.port, '/api/ping', { headers: markerHeaders('private') })
    expect(after.status).toBe(200)
  })

  it('慢上游应答前客户端断开的升级请求被归位：连接数归零且不残留握手定时器', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    expect((await call(status.port, '/api/ping', { headers: markerHeaders('private') })).status).toBe(200)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const baseline = vi.getTimerCount()
      const sockets: Duplex[] = []
      for (let index = 0; index < 3; index++)
        sockets.push(await stalledUpgrade(status.port, markerHeaders('private')))
      await until(() => upstream.upgrades.filter(entry => entry.url === '/stall').length === 3)
      expect(vi.getTimerCount()).toBe(baseline + 3)
      await Promise.all(sockets.map(async socket => await disconnect(socket)))
      await until(() => gateway.status('entry')?.connections === 0)
      expect(vi.getTimerCount()).toBe(baseline)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('冷缓存铸造窗口内客户端断开：不再向上游发起升级，连接数归零且不残留握手定时器', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    expect((await call(status.port, '/api/ping', { headers: markerHeaders('private') })).status).toBe(200)
    let renew = false
    let release = (): void => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = vi.fn(async (authority: string) => {
      if (renew)
        await pending
      return await upstream.mintUrlFor(authority)
    })
    await gateway.stop('entry')
    const restarted = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0, tokenProvider: provider })
    renew = true
    const before = upstream.upgrades.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sockets: Duplex[] = []
      for (let index = 0; index < 3; index++)
        sockets.push(await stalledUpgrade(restarted.port, markerHeaders('private')))
      await until(() => gateway.status('entry')?.connections === 3)
      const baseline = vi.getTimerCount()
      await until(() => provider.mock.calls.length === 1)
      await Promise.all(sockets.map(async socket => await disconnect(socket)))
      await until(() => gateway.status('entry')?.connections === 0)
      expect(upstream.upgrades.length).toBe(before)
      release()
      await until(() => vi.getTimerCount() <= baseline)
      expect(vi.getTimerCount()).toBe(baseline)
      await until(() => upstream.calls.length > 0)
      expect(upstream.upgrades.length).toBe(before)
    }
    finally {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })

  it('token provider 永不 settle 时铸造不再挂死：按 token 超时结束本次铸造，客户端拿到可读响应', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: async () => await new Promise<string>(() => {}) })
      const received: string[] = []
      const socket = connect(status.port, '127.0.0.1', () => {
        socket.write(`GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1:${status.port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n${GATEWAY_SOURCE_HEADER}: private\r\n${GATEWAY_SESSION_HEADER}: ${SESSION}\r\n\r\n`)
      })
      socket.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')))
      socket.on('error', () => {})
      await until(() => gateway.status('entry')?.connections === 1)
      await turns(4)
      expect(upstream.upgrades).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(10_001)
      await until(() => received.length > 0)
      const text = received.join('')
      expect(text.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized')
      expect(text.toLowerCase()).toContain('connection: close')
      expect(text.toLowerCase()).toContain('content-length: 0')
      expect(text.toLowerCase()).not.toContain('transfer-encoding')
      socket.destroy()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('未通过门禁的升级请求被拒绝且不触达上游', async () => {
    const status = await startEntry('inbound', upstream)
    const before = upstream.upgrades.length
    await expect(upgraded(status.port, '/api/remote.mux', markerHeaders('public'))).rejects.toThrow('403')
    expect(upstream.upgrades.length).toBe(before)
  })

  it('隧道入口自报来源头也拿不到门禁豁免：需认证的隧道请求按 401 拦下且不触达上游', async () => {
    const status = await gateway.start({ id: 'tunnel', kind: 'tunnel', upstream: upstream.origin, port: 0, tokenProvider: upstream.mintUrlFor, auth: () => policyOf() })
    const before = upstream.calls.length
    const reply = await call(status.port, '/api/ping', { headers: { ...tunnelHeaders(''), [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: SESSION } })
    expect(reply.status).toBe(401)
    expect(upstream.calls.length).toBe(before)
  })

  it('上游声明 content-length 拒绝升级时按声明长度重新组帧，不写出重复的长度头', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const raw = await rawUpgrade(status.port, '/upgrade-403', markerHeaders('private'))
    expect(raw.head).toBe('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: 18')
    expect(raw.body).toBe('denied by upstream')
  })

  it('401 重铸窗口内客户端断开：不再向上游发起重试升级，连接数归零且不残留握手定时器', async () => {
    let slow = false
    let release = (): void => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = vi.fn(async (authority: string) => {
      if (slow)
        await pending
      return await upstream.mintUrlFor(authority)
    })
    const status = await startEntry('inbound', upstream, { tokenProvider: provider })
    const headers = markerHeaders('private')
    const warm = await upgraded(status.port, '/api/remote.mux', headers)
    expect(warm.status).toBe(101)
    warm.socket.destroy()
    upstream.restart()
    slow = true
    const before = upstream.upgrades.filter(entry => entry.url === '/retry').length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sockets = [await stalledUpgrade(status.port, { ...headers }, '/retry'), await stalledUpgrade(status.port, { ...headers }, '/retry')]
      await until(() => upstream.upgrades.filter(entry => entry.url === '/retry').length === before + 2)
      await until(() => provider.mock.calls.length === 3)
      const baseline = vi.getTimerCount()
      await Promise.all(sockets.map(async socket => await disconnect(socket)))
      await until(() => gateway.status('entry')?.connections === 0)
      release()
      await until(() => vi.getTimerCount() <= baseline)
      expect(vi.getTimerCount()).toBe(baseline)
      expect(upstream.upgrades.filter(entry => entry.url === '/retry').length).toBe(before + 2)
    }
    finally {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })

  it('上游以分块拒绝升级时剥离逐跳头，只靠 connection: close 与 EOF 定界收束连接', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const raw = await rawUpgrade(status.port, '/upgrade-404', markerHeaders('private'))
    expect(raw.head).toBe('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\nconnection: close')
    expect(raw.head.toLowerCase()).not.toContain('transfer-encoding')
    expect(raw.head.toLowerCase()).not.toContain('content-length')
    expect(raw.body).toBe('denied by upstream')
  })

  it('升级首轮 401 时重铸 cookie 并重试成功，失败与重试各触达上游一次', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const live = await upgraded(status.port, '/api/remote.mux', markerHeaders('private'))
    expect(live.status).toBe(101)
    live.socket.destroy()

    upstream.restart()
    const retried = await upgraded(status.port, '/api/remote.mux', markerHeaders('private'))
    expect(retried.status).toBe(101)
    expect(upstream.upgrades).toHaveLength(3)
    const stale = grantedCookieOf(upstream.upgrades[1]?.headers ?? {})
    const headers = upstream.upgrades.at(-1)?.headers ?? {}
    expect(stale).toMatch(/^mint-/)
    expect(grantedCookieOf(headers)).not.toBe(stale)
    expect(grantedCookieOf(headers)).toMatch(/^mint-/)
    retried.socket.destroy()
  })

  it('上游迟迟不响应升级时按短超时回 504 并结束该连接', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
      const response = new Promise<string>((resolve, reject) => {
        const socket = connect(status.port, '127.0.0.1', () => socket.write(`GET /stall HTTP/1.1\r\nhost: 127.0.0.1:${status.port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n${GATEWAY_SOURCE_HEADER}: private\r\n${GATEWAY_SESSION_HEADER}: ${SESSION}\r\n\r\n`))
        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        socket.on('error', reject)
      })
      await upstream.waitForStall()
      await vi.advanceTimersByTimeAsync(30_001)
      const text = await settledTextOf(response)
      expect(text.split('\r\n')[0]).toBe('HTTP/1.1 504 Gateway Timeout')
      expect(text).toContain(upstream.origin)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('gateway 监听生命周期', () => {
  it('端口占用时回落到下一个可用端口，状态与入口 URL 反映真实端口', async () => {
    const occupied = await occupiedPortWithFreeNext()
    const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: occupied.port, tokenProvider: upstream.mintUrlFor })
    try {
      expect(status.port).toBe(occupied.port + 1)
      expect(status.url).toBe(`http://127.0.0.1:${occupied.port + 1}`)
      const reply = await call(status.port, '/api/ping')
      expect(reply.status).toBe(200)
    }
    finally {
      await occupied.release()
    }
  })

  it('请求临时端口 0 时正常绑定，不发出假的端口回落事件', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    try {
      const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0 })
      expect(status.port).toBeGreaterThan(0)
    }
    finally {
      unsubscribe()
    }
    expect(events.filter(event => event.kind === 'port')).toHaveLength(0)
  })

  it('优选端口为空闲时直接绑定，不发出端口回落事件', async () => {
    await withReservedPort(async (preferred) => {
      const events: RemoteGatewayEvent[] = []
      const unsubscribe = gateway.subscribe(event => events.push(event))
      try {
        const status = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: preferred })
        expect(status.port).toBe(preferred)
      }
      finally {
        unsubscribe()
      }
      expect(events.filter(event => event.kind === 'port')).toHaveLength(0)
    })
  })

  it('进程内端口登记表阻止两个入口抢同一个端口', async () => {
    const first = await gateway.start({ id: 'inbound', kind: 'inbound', upstream: upstream.origin, port: 0 })
    const second = await gateway.start({ id: 'machine', kind: 'outbound', upstream: upstream.origin, port: first.port })
    expect(second.port).not.toBe(first.port)
    expect(gateway.list().map(entry => entry.port).filter(port => port !== 0)).toHaveLength(2)
  })

  it('端口全部占用时保持关闭状态并报告可读错误', async () => {
    const holders = await occupyRange(21)
    const base = holders[0]?.port ?? 0
    try {
      await expect(gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: base })).rejects.toThrow(/网关端口全部占用/)
      expect(gateway.status('entry')).toMatchObject({ state: 'stopped', port: 0 })
    }
    finally {
      for (const holder of holders)
        await holder.release()
    }
  })

  it('重复开启同一入口时先关旧再开新，端口不残留', async () => {
    const free = await freePort()
    const preferred = free.port
    await free.release()
    const first = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: preferred })
    const second = await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: preferred })
    expect(first.port).toBe(preferred)
    expect(second.port).toBe(preferred)
    expect(gateway.list()).toHaveLength(1)
  })

  it('关闭入口后立即停止接受连接，并在秒级终止在途长连接', async () => {
    const status = await startEntry('inbound', upstream, { tokenProvider: upstream.mintUrlFor })
    const live = await streamed(status.port, '/sse', markerHeaders('private'))
    expect(live.status).toBe(200)
    const terminated = new Promise<string>((resolve) => {
      live.stream.on('close', () => resolve('closed'))
      live.stream.on('error', () => resolve('closed'))
      live.stream.resume()
    })
    const started = Date.now()
    await gateway.stop('entry')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await terminated).toBe('closed')
    expect(gateway.status('entry')).toMatchObject({ state: 'stopped', port: 0, connections: 0 })
    await expect(call(status.port, '/api/ping')).rejects.toThrow()
  })

  it('dispose 关闭全部入口并清空状态', async () => {
    await gateway.start({ id: 'inbound', kind: 'inbound', upstream: upstream.origin, port: 0 })
    await gateway.start({ id: 'machine', kind: 'outbound', upstream: upstream.origin, port: 0 })
    expect(gateway.list()).toHaveLength(2)
    await gateway.dispose()
    expect(gateway.list()).toHaveLength(0)
    expect(gateway.status('inbound')).toBeUndefined()
  })

  it('生命周期事件只在真实状态变化时发出，重复停止不再发第二条', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0 })
    await gateway.stop('entry')
    await gateway.stop('entry')
    unsubscribe()
    const stops = events.filter(event => event.kind === 'stopped')
    expect(stops).toHaveLength(1)
    expect(stops[0]?.line).not.toContain(':0')
  })

  it('dispose 不回收事件序号，消费者按 sinceSeq 增量拉取不会错序', async () => {
    const events: RemoteGatewayEvent[] = []
    const unsubscribe = gateway.subscribe(event => events.push(event))
    await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0 })
    const before = events.at(-1)?.seq ?? 0
    await gateway.dispose()
    await gateway.start({ id: 'entry', kind: 'inbound', upstream: upstream.origin, port: 0 })
    unsubscribe()
    const seqs = events.map(event => event.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(events.at(-1)?.seq).toBeGreaterThan(before)
  })
})

// --- test helpers ---
function externalAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find(entry => entry !== undefined && !entry.internal && entry.family === 'IPv4' && !entry.address.startsWith('127.'))
    ?.address
}

/** 绑定一个刚释放的固定端口：抢占窗口只有释放到监听的几毫秒，冲突时换端口重试整段。 */
async function withReservedPort<T>(body: (port: number) => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const free = await freePort()
    const port = free.port
    await free.release()
    try {
      return await body(port)
    }
    catch (error) {
      lastError = error
      if (!String(error).includes('EADDRINUSE'))
        throw error
    }
  }
  throw lastError
}

function freePortAt(port: number): Promise<{ port: number, release: () => Promise<void> } | undefined> {
  const server = createNetServer()
  return new Promise((resolve) => {
    server.once('error', () => resolve(undefined))
    server.listen(port, '127.0.0.1', () => {
      resolve({ port, release: () => new Promise<void>((done) => {
        server.close(() => done())
      }) })
    })
  })
}

/** 占用 P 且保证 P+1 空闲，使「回落到下一个可用端口」有唯一确定的期望值。 */
async function occupiedPortWithFreeNext(): Promise<{ port: number, release: () => Promise<void> }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = await freePort()
    const next = await freePortAt(base.port + 1)
    if (next !== undefined) {
      await next.release()
      return base
    }
    await base.release()
  }
  throw new Error('连续端口不可得')
}

async function occupyRange(size: number): Promise<Array<{ port: number, release: () => Promise<void> }>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = await freePort()
    const holders = [base]
    let complete = true
    for (let offset = 1; offset < size; offset++) {
      const holder = await freePortAt(base.port + offset)
      if (holder === undefined) {
        complete = false
        break
      }
      holders.push(holder)
    }
    if (complete)
      return holders
    for (const holder of holders)
      await holder.release()
  }
  throw new Error(`无法连续占满 ${size} 个端口`)
}
