import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import type { Duplex, Readable, Transform, Writable } from 'node:stream'
import type { RemoteAuthFailureRecord, RemoteAuthPolicy, RemoteGatewayEntryKind, RemoteGatewayEntryStatus, RemoteGatewayEvent, RemoteGatewayEventKind, RemoteGatewayStartOptions, RemoteGatewayTokenProvider, RemoteSessionTicket, RemoteSourceClass } from '../types/index'
import { Buffer } from 'node:buffer'
import { createServer, request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream'
import { defineService } from 'dsh-tauri'
import { messageOf } from '../../shared/error'
import { ensureSourceSession } from '../config/runtime'
import { rateLimitAfterFailure, rateLimitBlockedMs, signSession, tokenMatches, verifyPassword, verifySession } from '../utils/auth'
import { classifySource, decideSourceAccess, isAuthStorageBroken, rateLimitKeyOf } from '../utils/source'
import { authorityFor, cookiePairsOf, createCompressor, createDecompressor, deniedHtml, entryUrlOf, forwardHeadersOf, isCrossSiteRequest, isNavigationRequest, isReplayable, isUpgradeOf, loginPageHtml, mergeCookieHeader, parseCookieHeader, parseFormField, responseHeadersOf, responsePlanOf, supportsZstd, tunnelClientIpOf, upstreamPortOf } from './gateway.utils'

const LOOPBACK = '127.0.0.1'

const PORT_FALLBACK_LIMIT = 20

const PORTS_EXHAUSTED_CODE = 'ERR_GATEWAY_PORTS_EXHAUSTED'

const COMPRESS_MIN_BYTES = 1024

const SESSION_COOKIE = 'dsh_remote_session'

const AUTH_QUERY = 'auth'

const LOGIN_FIELD = 'password'

const FORM_BODY_LIMIT = 4096

const SHORT_TIMEOUT_MS = 30_000

const LONG_TIMEOUT_MS = 300_000

const MINT_TIMEOUT_MS = 10_000

const TOKEN_TIMEOUT_MS = 10_000

const DENIED_REASON = '尚未配置访问认证（密码或链接 Token），公网与隧道来源一律拒绝。请在本机回环来源的「远程 → 访问入口」中设置访问密码或链接 Token。'

const BROKEN_AUTH_REASON = '认证存储损坏，已视为未配置访问认证：公网与隧道来源一律拒绝。请在本机回环来源的「远程 → 访问入口」中重新设置访问密码。'

const CROSS_SITE_REASON = '跨站来源的请求被拒绝：网关会把 Origin 改写为回环 authority，因此必须在此拦下跨站发起方。'

const BANNED_REASON = '认证失败次数过多，请稍后重试。'

const UPSTREAM_ABORT_REASON = '上游响应在传输中途中断。'

interface GatewayEntry {
  id: string
  kind: RemoteGatewayEntryKind
  upstream: URL
  authority: string
  host: string
  port: number
  listening: boolean
  connections: number
  server: Server | undefined
  sockets: Set<Duplex>
  upstreamSockets: Set<Duplex>
  requests: Set<ClientRequest>
  tokenProvider: RemoteGatewayTokenProvider | undefined
  auth: (() => RemoteAuthPolicy) | undefined
}

interface ForwardAttempt {
  /** 本次请求是否带着 DSH 原生 cookie 发往上游；为 false 时 401 只透传，不重铸。 */
  credential: boolean
  retryable: boolean
}

const entries = new Map<string, GatewayEntry>()

const usedPorts = new Set<number>()

const mintedCookies = new Map<string, string>()

const mintedInFlight = new Map<string, Promise<string | undefined>>()

const authFailures = new Map<string, RemoteAuthFailureRecord>()

const subscribers = new Set<(event: RemoteGatewayEvent) => void>()

let eventSeq = 0

export const gateway = defineService({
  async start(options: RemoteGatewayStartOptions): Promise<RemoteGatewayEntryStatus> {
    return await startEntry(options)
  },

  async stop(id: string): Promise<void> {
    await stopEntry(id)
  },

  status(id: string): RemoteGatewayEntryStatus | undefined {
    const entry = entries.get(id)
    return entry === undefined ? undefined : entryStatus(entry)
  },

  list(): RemoteGatewayEntryStatus[] {
    return [...entries.values()].map(entryStatus)
  },

  subscribe(listener: (event: RemoteGatewayEvent) => void): () => void {
    subscribers.add(listener)
    return () => {
      subscribers.delete(listener)
    }
  },

  async dispose(): Promise<void> {
    for (const id of [...entries.keys()])
      await stopEntry(id)
    entries.clear()
    usedPorts.clear()
    mintedCookies.clear()
    mintedInFlight.clear()
    authFailures.clear()
    subscribers.clear()
  },
})

// --- internal ---
async function startEntry(options: RemoteGatewayStartOptions): Promise<RemoteGatewayEntryStatus> {
  await stopEntry(options.id)
  const upstream = new URL(options.upstream)
  if (upstream.protocol !== 'http:')
    throw new TypeError(`网关上游必须是 http URL：${options.upstream}`)
  const host = options.kind === 'inbound' ? options.host ?? LOOPBACK : LOOPBACK
  const entry: GatewayEntry = {
    id: options.id,
    kind: options.kind,
    upstream,
    authority: authorityFor(options.kind, upstream, options.port),
    host,
    port: 0,
    listening: false,
    connections: 0,
    server: undefined,
    sockets: new Set(),
    upstreamSockets: new Set(),
    requests: new Set(),
    tokenProvider: options.tokenProvider,
    auth: options.auth,
  }
  entries.set(entry.id, entry)
  try {
    const binding = await bindEntry(entry, options.port)
    entry.server = binding.server
    entry.port = binding.port
    entry.listening = true
    usedPorts.add(binding.port)
  }
  catch (error) {
    entry.listening = false
    entry.port = 0
    throw error
  }
  if (options.port !== 0 && entry.port !== options.port)
    emit(entry, 'port', `首选端口 ${options.port} 不可用，已回落到 ${entry.port}`)
  emit(entry, 'listening', `网关入口已监听 ${entryUrlOf(entry.host, entry.port)}，上游 ${options.upstream}`)
  return entryStatus(entry)
}

async function stopEntry(id: string): Promise<void> {
  const entry = entries.get(id)
  if (entry === undefined)
    return
  const wasListening = entry.listening
  const stoppedPort = entry.port
  const stoppedAuthority = entry.authority
  entry.listening = false
  entry.connections = 0
  if (stoppedPort !== 0)
    usedPorts.delete(stoppedPort)
  mintedCookies.delete(stoppedAuthority)
  mintedInFlight.delete(stoppedAuthority)
  entry.port = 0
  for (const request of entry.requests)
    request.destroy()
  entry.requests.clear()
  for (const socket of entry.upstreamSockets)
    socket.destroy()
  entry.upstreamSockets.clear()
  const server = entry.server
  entry.server = undefined
  if (server !== undefined) {
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    for (const socket of [...entry.sockets])
      socket.destroy()
    await closed
  }
  entry.sockets.clear()
  if (wasListening)
    emit(entry, 'stopped', `网关入口已停止 ${entryUrlOf(entry.host, stoppedPort)}`)
}

function entryStatus(entry: GatewayEntry): RemoteGatewayEntryStatus {
  return {
    id: entry.id,
    kind: entry.kind,
    state: entry.listening ? 'listening' : 'stopped',
    host: entry.host,
    port: entry.port,
    url: entry.listening ? entryUrlOf(entry.host, entry.port) : '',
    upstream: entry.upstream.origin,
    connections: entry.connections,
  }
}

async function bindEntry(entry: GatewayEntry, preferred: number): Promise<{ server: Server, port: number }> {
  let lastError: unknown
  for (let offset = 0; offset <= PORT_FALLBACK_LIMIT; offset++) {
    const candidate = preferred + offset
    if (candidate > 65535 || usedPorts.has(candidate))
      continue
    entry.port = candidate
    entry.authority = authorityFor(entry.kind, entry.upstream, candidate)
    try {
      const server = await listenAt(entry, candidate)
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : candidate
      entry.port = bound
      entry.authority = authorityFor(entry.kind, entry.upstream, bound)
      return { server, port: bound }
    }
    catch (error) {
      lastError = error
      if (codeOf(error) !== 'EADDRINUSE')
        throw error
    }
  }
  const error = new Error(`网关端口全部占用：已尝试 ${preferred}-${Math.min(preferred + PORT_FALLBACK_LIMIT, 65535)}${lastError === undefined ? '' : `（${messageOf(lastError)}）`}`) as NodeJS.ErrnoException
  error.code = PORTS_EXHAUSTED_CODE
  throw error
}

function listenAt(entry: GatewayEntry, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleRequest(entry, request, response)
    })
    server.on('upgrade', (request, socket, head) => {
      void handleUpgrade(entry, request, socket, head)
    })
    server.on('connection', (socket) => {
      entry.sockets.add(socket)
      entry.connections += 1
      socket.on('close', () => {
        entry.sockets.delete(socket)
        entry.connections = Math.max(0, entry.connections - 1)
      })
    })
    const onError = (error: Error) => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, entry.host, () => {
      server.off('error', onError)
      server.on('error', (error) => {
        emit(entry, 'upstream', `网关入口监听错误：${messageOf(error)}`)
      })
      resolve(server)
    })
  })
}

function handleRequest(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse): Promise<void> {
  return dispatchRequest(entry, request, response).catch((error) => {
    writeGatewayError(entry, response, 500, `网关请求处理失败：${messageOf(error)}`)
  })
}

async function dispatchRequest(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (isCrossSiteRequest(entry.kind, request.headers)) {
    writeDenied(request, response, CROSS_SITE_REASON)
    return
  }
  const session = ensureSourceSession()
  const source = sourceOf(entry, request, session)
  const policy = entry.auth?.()
  const decision = decideSourceAccess(source, policy)
  if (decision === 'deny') {
    writeDenied(request, response, denyReasonOf(policy))
    return
  }
  if (decision === 'authenticate') {
    if (policy === undefined || !await admitAuthenticated(entry, request, response, source, policy))
      return
  }
  await forward(entry, request, response, source, session)
}

/** 隧道入口的物理对端恒为回环，来源分类恒为 tunnel：不得采信任何请求头，否则 §7.2 门禁可被自报头绕过（S2 §7.1、§9）。 */
function sourceOf(entry: GatewayEntry, request: IncomingMessage, session: string): RemoteSourceClass {
  return entry.kind === 'tunnel' ? 'tunnel' : classifySource(request.headers, request.socket.remoteAddress, session)
}

function denyReasonOf(policy: RemoteAuthPolicy | undefined): string {
  return isAuthStorageBroken(policy) ? BROKEN_AUTH_REASON : DENIED_REASON
}

async function admitAuthenticated(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse, source: RemoteSourceClass, policy: RemoteAuthPolicy): Promise<boolean> {
  const now = Date.now()
  const bucket = rateLimitKeyOf(source, request.socket.remoteAddress, entry.kind === 'tunnel' ? tunnelClientIpOf(request.headers) : undefined)
  if (verifySession(parseCookieHeader(cookieHeaderOf(request.headers.cookie)).get(SESSION_COOKIE), policy.sessionSecret, now))
    return true
  const banned = rateLimitBlockedMs(authFailures.get(bucket), now)
  if (banned > 0) {
    writeAuthChallenge(request, response, BANNED_REASON, 429, banned)
    return false
  }
  const url = new URL(request.url ?? '/', 'http://gateway.invalid')
  if (request.method === 'GET' && url.pathname === '/' && url.searchParams.has(AUTH_QUERY)) {
    if (tokenMatches(url.searchParams.get(AUTH_QUERY) ?? undefined, policy.linkToken)) {
      authFailures.delete(bucket)
      writeSessionRedirect(response, policy, url.pathname, now)
      return false
    }
    failAuth(bucket, now, request, response, '链接已失效，请输入访问密码。')
    return false
  }
  if (isLoginSubmission(request)) {
    const submitted = parseFormField(await readFormBody(request), LOGIN_FIELD)
    if (submitted !== undefined && verifyPassword(submitted, policy.password)) {
      authFailures.delete(bucket)
      writeSessionRedirect(response, policy, `${url.pathname}${url.search}`, now)
      return false
    }
    failAuth(bucket, now, request, response, '密码不正确。')
    return false
  }
  writeAuthChallenge(request, response, undefined, 401, 0)
  return false
}

/** 登录表单是导航形态的 urlencoded POST：API 客户端带 password 字段的 POST 不得被当成登录（S2 §7.3）。 */
function isLoginSubmission(request: IncomingMessage): boolean {
  if (request.method !== 'POST' || !isNavigationRequest(request.headers))
    return false
  return headerText(request.headers['content-type'])?.toLowerCase().startsWith('application/x-www-form-urlencoded') === true
}

function failAuth(bucket: string, now: number, request: IncomingMessage, response: ServerResponse, reason: string): void {
  const record = rateLimitAfterFailure(authFailures.get(bucket), now)
  authFailures.set(bucket, record)
  const remaining = rateLimitBlockedMs(record, now)
  writeAuthChallenge(
    request,
    response,
    remaining > 0 ? `${BANNED_REASON}（剩余 ${Math.ceil(remaining / 1000)} 秒）` : reason,
    remaining > 0 ? 429 : 401,
    remaining,
  )
}

function writeAuthChallenge(request: IncomingMessage, response: ServerResponse, message: string | undefined, status: number, retryAfterMs: number): void {
  const text = message ?? '需要认证后才能访问。'
  if (!isNavigationRequest(request.headers)) {
    writeJson(response, status, text, retryAfterMs)
    return
  }
  const html = loginPageHtml(message)
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...retryAfterMs > 0 ? { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } : {},
  })
  response.end(html)
}

function writeSessionRedirect(response: ServerResponse, policy: RemoteAuthPolicy, target: string, now: number): void {
  const ticket = signSession(policy.sessionSecret, now)
  response.writeHead(302, {
    'location': target,
    'set-cookie': sessionCookieOf(ticket, now),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end()
}

function sessionCookieOf(ticket: RemoteSessionTicket, now: number): string {
  const maxAge = Math.max(0, Math.floor((ticket.expiresAt - now) / 1000))
  return `${SESSION_COOKIE}=${ticket.value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`
}

function writeDenied(request: IncomingMessage, response: ServerResponse, reason: string): void {
  if (!isNavigationRequest(request.headers)) {
    writeJson(response, 403, reason, 0)
    return
  }
  const html = deniedHtml(reason)
  response.writeHead(403, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
  })
  response.end(html)
}

function writeJson(response: ServerResponse, status: number, message: string, retryAfterMs: number): void {
  const body = JSON.stringify({ error: message })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    ...retryAfterMs > 0 ? { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } : {},
  })
  response.end(body)
}

async function forward(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse, source: RemoteSourceClass, session: string): Promise<void> {
  const inject = entry.kind !== 'outbound'
  const headers = forwardHeadersOf(request.headers, {
    authority: entry.authority,
    upgrade: isUpgradeOf(request.headers),
    ...inject ? { source, session } : {},
    ...entry.kind === 'outbound' ? { identity: true } : {},
  })
  const cookie = await ensureMintedCookie(entry)
  if (cookie !== undefined)
    headers.cookie = mergeCookieHeader(cookieHeaderOf(headers.cookie), [cookie])
  await sendUpstream(entry, request, response, headers, { retryable: true, credential: cookie !== undefined }, source)
}

function sendUpstream(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse, headers: OutgoingHttpHeaders, attempt: ForwardAttempt, source: RemoteSourceClass): Promise<void> {
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: entry.upstream.hostname,
      port: upstreamPortOf(entry.upstream),
      method: request.method,
      path: request.url ?? '/',
      headers,
      agent: false,
    })
    entry.requests.add(upstream)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      upstream.destroy()
    }, isWriteClass(request.method) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS)
    upstream.on('response', (upstreamResponse) => {
      clearTimeout(timer)
      entry.requests.delete(upstream)
      void respondUpstream(entry, request, response, upstreamResponse, headers, attempt, source)
        .catch((error) => {
          writeGatewayError(entry, response, 500, `网关响应处理失败：${messageOf(error)}`)
        })
        .finally(resolve)
    })
    upstream.on('error', (error) => {
      clearTimeout(timer)
      entry.requests.delete(upstream)
      const reason = timedOut
        ? timeoutReasonOf(entry)
        : `上游不可达：${entry.upstream.origin}（${codeOf(error) ?? messageOf(error)}）`
      writeGatewayError(entry, response, timedOut ? 504 : 502, reason)
      resolve()
    })
    request.pipe(upstream)
  })
}

async function respondUpstream(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse, upstreamResponse: IncomingMessage, headers: OutgoingHttpHeaders, attempt: ForwardAttempt, source: RemoteSourceClass): Promise<void> {
  if (upstreamResponse.statusCode === 401 && attempt.retryable && attempt.credential && entry.tokenProvider !== undefined && isReplayable(request.headers)) {
    upstreamResponse.pause()
    mintedCookies.delete(entry.authority)
    const cookie = await mintCookie(entry)
    if (cookie !== undefined) {
      upstreamResponse.destroy()
      const retried = { ...headers, cookie: mergeCookieHeader(cookieHeaderOf(headers.cookie), [cookie]) }
      await sendUpstream(entry, request, response, retried, { retryable: false, credential: true }, source)
      return
    }
    upstreamResponse.resume()
  }
  writeUpstreamBody(entry, request, response, upstreamResponse, source)
}

function writeUpstreamBody(entry: GatewayEntry, request: IncomingMessage, response: ServerResponse, upstreamResponse: IncomingMessage, source: RemoteSourceClass): void {
  const plan = responsePlanOf({
    acceptEncoding: headerText(request.headers['accept-encoding']),
    contentType: headerText(upstreamResponse.headers['content-type']),
    contentLength: contentLengthOf(upstreamResponse.headers['content-length']),
    upstreamEncoding: headerText(upstreamResponse.headers['content-encoding']),
    supportsZstd: supportsZstd(),
    compress: source !== 'loopback',
    minBytes: COMPRESS_MIN_BYTES,
  })
  const headers = responseHeadersOf(upstreamResponse.headers)
  if (entry.kind !== 'outbound')
    delete headers['set-cookie']
  const status = upstreamResponse.statusCode ?? 200
  const decompressor = plan.decode === undefined ? undefined : createDecompressor(plan.decode)
  const coding = plan.coding !== undefined && (plan.decode === undefined || decompressor !== undefined) ? plan.coding : undefined
  if (source !== 'loopback')
    appendVary(headers)
  if (coding === undefined) {
    if (decompressor === undefined) {
      pipeThrough(entry, upstreamResponse, response, status, headers, undefined)
      return
    }
    delete headers['content-encoding']
    delete headers['content-length']
    pipeThrough(entry, upstreamResponse, response, status, headers, decompressor)
    return
  }
  delete headers['content-length']
  delete headers['content-encoding']
  headers['content-encoding'] = coding
  if (!plan.buffered) {
    pipeThrough(entry, upstreamResponse, response, status, headers, decompressor, createCompressor(coding, plan.streaming))
    return
  }
  pipeBuffered(entry, upstreamResponse, response, status, headers, coding)
}

function pipeThrough(entry: GatewayEntry, upstreamResponse: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders, decompressor?: Transform, compressor?: Transform): void {
  response.writeHead(status, headers)
  const stages: (Readable | Writable)[] = [upstreamResponse]
  if (decompressor !== undefined)
    stages.push(decompressor)
  if (compressor !== undefined)
    stages.push(compressor)
  stages.push(response)
  pipeline(stages, (error) => {
    if (error != null && (!upstreamResponse.complete || codeOf(error) !== 'ERR_STREAM_PREMATURE_CLOSE'))
      emit(entry, 'compression', `响应流中断：${messageOf(error)}（${entry.upstream.origin}）`)
  })
}

function pipeBuffered(entry: GatewayEntry, upstreamResponse: IncomingMessage, response: ServerResponse, status: number, headers: OutgoingHttpHeaders, coding: 'zstd' | 'gzip'): void {
  const chunks: Buffer[] = []
  let total = 0
  let decided = false
  let compressor: Transform | undefined

  function onData(chunk: Buffer): void {
    chunks.push(chunk)
    total += chunk.length
    if (total >= COMPRESS_MIN_BYTES)
      decide(true)
  }

  function decide(compress: boolean): void {
    if (decided)
      return
    decided = true
    upstreamResponse.off('data', onData)
    upstreamResponse.pause()
    if (!compress) {
      delete headers['content-encoding']
      headers['content-length'] = String(total)
      response.writeHead(status, headers)
      for (const chunk of chunks)
        response.write(chunk)
      upstreamResponse.pipe(response)
    }
    else {
      response.writeHead(status, headers)
      compressor = createCompressor(coding, false)
      compressor.pipe(response)
      for (const chunk of chunks)
        compressor.write(chunk)
      upstreamResponse.pipe(compressor)
    }
    upstreamResponse.resume()
  }

  function fail(error: unknown): void {
    const reason = messageOf(error)
    if (!decided) {
      decided = true
      upstreamResponse.off('data', onData)
      upstreamResponse.destroy()
      emit(entry, 'compression', `上游响应流错误，已终止该响应：${entry.upstream.origin}（${reason}）`)
      if (!response.headersSent)
        writeJson(response, 502, `${UPSTREAM_ABORT_REASON}（${entry.upstream.origin}）`, 0)
      return
    }
    emit(entry, 'compression', `上游响应流错误，已中止压缩响应：${reason}`)
    compressor?.destroy()
    response.destroy()
  }

  upstreamResponse.on('data', onData)
  upstreamResponse.on('end', () => {
    decide(false)
  })
  upstreamResponse.on('error', fail)
  response.on('close', () => {
    if (!decided) {
      decided = true
      upstreamResponse.destroy()
    }
  })
}

function handleUpgrade(entry: GatewayEntry, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  return dispatchUpgrade(entry, request, socket, head).catch(() => {
    rejectUpgrade(socket, 500, '网关升级处理失败。')
  })
}
async function dispatchUpgrade(entry: GatewayEntry, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  if (isCrossSiteRequest(entry.kind, request.headers)) {
    rejectUpgrade(socket, 403, CROSS_SITE_REASON)
    return
  }
  const session = ensureSourceSession()
  const source = sourceOf(entry, request, session)
  const policy = entry.auth?.()
  const decision = decideSourceAccess(source, policy)
  const admitted = decision === 'allow'
    || (decision === 'authenticate' && policy !== undefined && verifySession(parseCookieHeader(cookieHeaderOf(request.headers.cookie)).get(SESSION_COOKIE), policy.sessionSecret, Date.now()))
  if (!admitted) {
    rejectUpgrade(socket, decision === 'deny' ? 403 : 401, decision === 'deny' ? denyReasonOf(policy) : '需要认证后才能访问。')
    return
  }
  const inject = entry.kind !== 'outbound'
  const headers = forwardHeadersOf(request.headers, {
    authority: entry.authority,
    upgrade: true,
    ...inject ? { source, session } : {},
    ...entry.kind === 'outbound' ? { identity: true } : {},
  })
  const release = guardUpgradeSocket(socket)
  let cookie: string | undefined
  try {
    cookie = await ensureMintedCookie(entry)
  }
  finally {
    release()
  }
  if (socket.destroyed)
    return
  if (cookie !== undefined)
    headers.cookie = mergeCookieHeader(cookieHeaderOf(headers.cookie), [cookie])
  openUpgrade(entry, request, socket, head, headers, { retryable: true, credential: cookie !== undefined })
}

/**
 * 铸造窗口的活性守卫：冷缓存下 `ensureMintedCookie` 会 await 到远端 token，期间客户端可能已经断开，
 * 而 `openUpgrade` 的 end/close 监听要到铸造之后才注册——两个事件都已错过，之后仍会向上游完成 101
 * 却再没有代码销毁下游 socket，半开 fd 与 §10 的活跃连接数一起泄漏。守卫必须早于 await 注册，
 * 断开时直接销毁 socket，`socket.destroyed` 即铸造之后判定是否还要向上游拨号的依据。
 */
function guardUpgradeSocket(socket: Duplex): () => void {
  const close = (): void => {
    socket.destroy()
  }
  socket.on('close', close)
  socket.on('end', close)
  return () => {
    socket.off('close', close)
    socket.off('end', close)
  }
}

/** 升级被拒或超时：网关自行组帧（content-length 与正文一致），不复制上游的逐跳头。 */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message })
  socket.end(`HTTP/1.1 ${status} ${statusTextOf(status)}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
}

/** 非 101 的上游响应已经过分块解码，转发时必须剥掉逐跳头、按真实长度重新组帧并显式收束连接（S2 §8.4）。 */
function rejectFromUpstream(entry: GatewayEntry, socket: Duplex, upstreamResponse: IncomingMessage): void {
  const headers = responseHeadersOf(upstreamResponse.headers)
  if (entry.kind !== 'outbound')
    delete headers['set-cookie']
  const declared = contentLengthOf(upstreamResponse.headers['content-length'])
  delete headers['content-length']
  headers.connection = 'close'
  const head = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ''}`]
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value])
      head.push(`${name}: ${item ?? ''}`)
  }
  if (declared !== undefined)
    head.push(`content-length: ${declared}`)
  writeSocket(socket, `${head.join('\r\n')}\r\n\r\n`)
  upstreamResponse.pipe(socket)
}

function upgradeHeadLines(entry: GatewayEntry, status: number, statusMessage: string, rawHeaders: string[]): string {
  const lines = [`HTTP/1.1 ${status} ${statusMessage}`]
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? ''
    if (entry.kind !== 'outbound' && name.toLowerCase() === 'set-cookie')
      continue
    lines.push(`${name}: ${rawHeaders[index + 1] ?? ''}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function openUpgrade(entry: GatewayEntry, request: IncomingMessage, socket: Duplex, head: Buffer, headers: OutgoingHttpHeaders, attempt: ForwardAttempt): void {
  const upstream = httpRequest({
    host: entry.upstream.hostname,
    port: upstreamPortOf(entry.upstream),
    method: request.method,
    path: request.url ?? '/',
    headers,
    agent: false,
  })
  entry.requests.add(upstream)
  let live = true
  let timer: NodeJS.Timeout
  const settle = (): boolean => {
    clearTimeout(timer)
    entry.requests.delete(upstream)
    socket.off('close', endUpgrade)
    socket.off('end', endUpgrade)
    const first = live
    live = false
    return first
  }
  /** 客户端在慢上游应答前断开时 socket 只报 'end' 不报 'close'，两者都必须归位：否则定时器、fd 与上游请求无界累积。 */
  function endUpgrade(): void {
    settle()
    socket.destroy()
    upstream.destroy()
  }
  const timeout = (): void => {
    settle()
    rejectUpgrade(socket, 504, timeoutReasonOf(entry))
    socket.destroy()
    upstream.destroy()
  }
  timer = setTimeout(timeout, SHORT_TIMEOUT_MS)
  socket.on('close', endUpgrade)
  socket.on('end', endUpgrade)
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    if (!settle())
      return
    entry.upstreamSockets.add(upstreamSocket)
    upstreamSocket.on('close', () => entry.upstreamSockets.delete(upstreamSocket))
    writeSocket(socket, upgradeHeadLines(entry, upstreamResponse.statusCode ?? 101, upstreamResponse.statusMessage ?? 'Switching Protocols', upstreamResponse.rawHeaders))
    if (upstreamHead.length > 0)
      writeSocket(socket, upstreamHead)
    upstreamSocket.on('error', () => upstreamSocket.destroy())
    socket.pipe(upstreamSocket)
    upstreamSocket.pipe(socket)
    socket.on('end', () => upstreamSocket.destroy())
    upstreamSocket.on('end', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  })
  upstream.on('response', (upstreamResponse) => {
    if (!settle())
      return
    if (upstreamResponse.statusCode === 401 && attempt.retryable && attempt.credential && entry.tokenProvider !== undefined) {
      upstreamResponse.resume()
      mintedCookies.delete(entry.authority)
      const release = guardUpgradeSocket(socket)
      void mintCookie(entry).then((cookie) => {
        if (cookie === undefined) {
          rejectUpgrade(socket, 401, '需要认证后才能访问。')
          return
        }
        if (socket.destroyed)
          return
        openUpgrade(entry, request, socket, head, { ...headers, cookie: mergeCookieHeader(cookieHeaderOf(headers.cookie), [cookie]) }, { retryable: false, credential: true })
      }).catch(() => {
        rejectUpgrade(socket, 502, 'DSH 原生 cookie 重铸失败。')
      }).finally(release)
      return
    }
    rejectFromUpstream(entry, socket, upstreamResponse)
  })
  upstream.on('error', () => {
    settle()
    socket.destroy()
  })
  if (head.length > 0)
    upstream.write(head)
  request.pipe(upstream)
}

function statusTextOf(status: number): string {
  switch (status) {
    case 401:
      return 'Unauthorized'
    case 403:
      return 'Forbidden'
    case 502:
      return 'Bad Gateway'
    case 504:
      return 'Gateway Timeout'
    default:
      return 'Internal Server Error'
  }
}

function writeSocket(socket: Duplex, chunk: string | Buffer): void {
  if (!socket.destroyed && socket.writable)
    socket.write(chunk)
}

async function ensureMintedCookie(entry: GatewayEntry): Promise<string | undefined> {
  const cached = mintedCookies.get(entry.authority)
  if (cached !== undefined)
    return cached
  const pending = mintedInFlight.get(entry.authority)
  if (pending !== undefined)
    return await pending
  const minted = mintCookie(entry)
  mintedInFlight.set(entry.authority, minted)
  try {
    return await minted
  }
  finally {
    mintedInFlight.delete(entry.authority)
  }
}

async function mintCookie(entry: GatewayEntry): Promise<string | undefined> {
  const provider = entry.tokenProvider
  if (provider === undefined)
    return undefined
  let mintUrl: string | undefined
  try {
    mintUrl = await withTimeout(provider(entry.authority))
  }
  catch (error) {
    emit(entry, 'cookie', `DSH 原生 cookie 铸造失败（token 不可用），已透传上游响应：${messageOf(error)}`)
    return undefined
  }
  if (mintUrl === undefined) {
    emit(entry, 'cookie', `DSH 原生 cookie 铸造失败（token 不可用），已透传上游响应（${entry.authority}）`)
    return undefined
  }
  const pairs = await requestMint(entry, mintUrl)
  if (pairs.length === 0) {
    emit(entry, 'cookie', `DSH 原生 cookie 铸造未取到会话 cookie，已透传上游响应（${entry.authority}）`)
    return undefined
  }
  const cookie = pairs.join('; ')
  mintedCookies.set(entry.authority, cookie)
  return cookie
}

function requestMint(entry: GatewayEntry, mintUrl: string): Promise<string[]> {
  return new Promise((resolve) => {
    let path: string
    try {
      const url = new URL(mintUrl)
      path = `${url.pathname}${url.search}`
    }
    catch {
      resolve([])
      return
    }
    const request = httpRequest({
      host: entry.upstream.hostname,
      port: upstreamPortOf(entry.upstream),
      method: 'GET',
      path,
      headers: { host: entry.authority, accept: 'text/html', connection: 'close' },
      agent: false,
    })
    const timer = setTimeout(() => {
      request.destroy()
    }, MINT_TIMEOUT_MS)
    request.on('response', (response) => {
      clearTimeout(timer)
      const pairs = cookiePairsOf(response.headers['set-cookie'])
      response.resume()
      resolve(pairs)
    })
    request.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
    request.end()
  })
}

/** token provider 本身也必须限时：它一旦永不 settle，挂起的铸造链会一直持有 request、socket 与 head。 */
function withTimeout(pending: Promise<string | undefined>): Promise<string | undefined> {
  let timer: NodeJS.Timeout
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, TOKEN_TIMEOUT_MS, undefined)
  })
  void pending.catch(() => undefined).finally(() => clearTimeout(timer))
  return Promise.race([pending, expiry])
}

async function readFormBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > FORM_BODY_LIMIT)
      return ''
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeGatewayError(entry: GatewayEntry, response: ServerResponse, status: number, reason: string): void {
  emit(entry, 'upstream', reason)
  if (response.headersSent) {
    response.destroy()
    return
  }
  writeJson(response, status, reason, 0)
}

function appendVary(headers: OutgoingHttpHeaders): void {
  const existing = headers.vary
  const value = Array.isArray(existing) ? existing.join(', ') : typeof existing === 'string' ? existing : ''
  const tokens = value.toLowerCase().split(',').map(token => token.trim())
  if (!tokens.includes('accept-encoding'))
    headers.vary = value === '' ? 'accept-encoding' : `${value}, accept-encoding`
}

function emit(entry: { id: string }, kind: RemoteGatewayEventKind, line: string): void {
  eventSeq += 1
  const event: RemoteGatewayEvent = { seq: eventSeq, ts: new Date().toISOString(), id: entry.id, kind, line }
  for (const listener of [...subscribers]) {
    try {
      listener(event)
    }
    catch {
      continue
    }
  }
}

function cookieHeaderOf(value: number | string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value.join('; ')
  return value === undefined ? undefined : String(value)
}

function headerText(value: number | string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value[0]
  return value === undefined ? undefined : String(value)
}

function contentLengthOf(value: number | string | string[] | undefined): number | undefined {
  const text = headerText(value)
  if (text === undefined)
    return undefined
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function isWriteClass(method: string | undefined): boolean {
  return method !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function timeoutReasonOf(entry: GatewayEntry): string {
  return `上游超时：${entry.upstream.origin}`
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null)
    return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
