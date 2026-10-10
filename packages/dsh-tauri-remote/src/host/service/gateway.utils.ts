import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import type { Transform } from 'node:stream'
import type { RemoteGatewayEntryKind } from '../types/index'
import type { RemoteForwardPlan, RemoteResponsePlan, RemoteResponsePlanInput } from './gateway.types'
import * as zlib from 'node:zlib'
import { GATEWAY_SESSION_HEADER, GATEWAY_SOURCE_HEADER } from '../config/constants'
import { classifyPeer, isIpAddress } from '../utils/source'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const BINARY_TYPE = /^(?:image|audio|video|font)\//

const ARCHIVE_TYPE = /^application\/(?:zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-tar|zstd|x-bzip2|x-bzip|x-lzma|x-xz|x-compress)$/

const IDENTITY = 'identity'

/** 转发时使用的上游 authority（S2 §5.1）：出站取浏览器所见的网关回环端口，入站取上游自身的回环 authority。 */
export function authorityFor(kind: RemoteGatewayEntryKind, upstream: URL, port: number): string {
  return kind === 'outbound' ? `127.0.0.1:${port}` : upstream.host
}

export function entryUrlOf(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export function upstreamPortOf(upstream: URL): number {
  return upstream.port === '' ? 80 : Number(upstream.port)
}

/**
 * 请求头改写与注入：Host 一律改写为转发 authority；Origin 存在时对齐到同一 authority；两枚内部
 * 来源标识头先剥离再按计划写入（出站腿 source/session 缺省，剥离后即不再出现）；非升级请求丢弃
 * 逐跳头；出站腿对上游声明 identity，避免与 SSH 链路压缩叠加。
 *
 * 非升级请求还必须自带分帧：transfer-encoding 属于逐跳头会被剥掉，而 Node 的客户端只为 POST/PUT/PATCH
 * 默认启用分块，其余方法（GET/HEAD/DELETE/OPTIONS/TRACE/CONNECT）会把已解码的正文当**裸尾部字节**写出，
 * 客户端可控的那串字节于是能在上游连接上拼出第二个请求。这里按上游声明的分帧重建：有可信长度就带
 * content-length，否则显式声明 chunked 让 Node 重新分块，任何形态都自描述。
 */
export function forwardHeadersOf(headers: IncomingHttpHeaders, plan: RemoteForwardPlan): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  const passthroughHopByHop = plan.upgrade === true
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined)
      continue
    const lower = name.toLowerCase()
    if (lower === GATEWAY_SOURCE_HEADER || lower === GATEWAY_SESSION_HEADER || lower === 'host' || lower === 'origin')
      continue
    if (!passthroughHopByHop && HOP_BY_HOP.has(lower))
      continue
    out[lower] = value
  }
  if (!passthroughHopByHop)
    reframeBody(headers, out)
  out.host = plan.authority
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '')
    out.origin = `http://${plan.authority}`
  if (plan.source !== undefined && plan.session !== undefined && plan.session !== '') {
    out[GATEWAY_SOURCE_HEADER] = plan.source
    out[GATEWAY_SESSION_HEADER] = plan.session
  }
  if (plan.identity === true)
    out['accept-encoding'] = IDENTITY
  return out
}

export function responseHeadersOf(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase()))
      continue
    out[name.toLowerCase()] = value
  }
  return out
}

function headerText(value: number | string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value[0]
  return value === undefined ? undefined : String(value)
}

export function isUpgradeOf(headers: IncomingHttpHeaders): boolean {
  if (typeof headers.upgrade === 'string' && headers.upgrade !== '')
    return true
  const connection = headers.connection
  return typeof connection === 'string' && connection.toLowerCase().split(',').some(token => token.trim() === 'upgrade')
}

export function isNavigationRequest(headers: IncomingHttpHeaders): boolean {
  const accept = headers.accept
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html')
}

/**
 * 跨站发起方判定：网关会把任何非空 Origin 改写成回环 authority，因此必须在改写前拦下跨站来源，
 * 否则上游仅存的 `sec-fetch-site` 防线（WebSocket 握手不带该头时只剩 Origin）会被抹平。
 * 同源判定以浏览器实际使用的 Host 为准；隧道腿的 Host 由 cloudflared 改写成回环 authority，
 * 该比对无从进行，此时只信浏览器自己算出的同源结论：非导航请求仅接受 `same-origin` / `none`
 * （`same-site` 说明是同一注册域下的兄弟子域，SameSite=Lax 会话 cookie 会被带上，必须拒绝），
 * 无 Fetch 元数据（非浏览器客户端、旧浏览器）一律拒绝——隧道腿上无从区分它与伪装成同源的跨站请求。
 * 跨站的文档导航（壳层 iframe、外站链接）一律放行：落地文档的源随即变成入口自身，后续请求都同源。
 */
export function isCrossSiteRequest(kind: RemoteGatewayEntryKind, headers: IncomingHttpHeaders): boolean {
  const rewritten = hostRewritten(kind, headers)
  const origin = headerText(headers.origin)
  if (origin !== undefined && origin !== '' && !rewritten) {
    const host = headerText(headers.host)
    if (host === undefined || host === '')
      return true
    try {
      if (new URL(origin).host !== new URL(`http://${host}`).host)
        return true
    }
    catch {
      return true
    }
  }
  const site = headerText(headers['sec-fetch-site'])
  const navigate = headerText(headers['sec-fetch-mode']) === 'navigate'
  if (site !== 'cross-site')
    return rewritten && !navigate && site !== 'same-origin' && site !== 'none'
  return !navigate
}

/** 可重放 = 无请求体：请求体一旦开始发送就不重试（S2 §6 失效列）。 */
export function isReplayable(headers: IncomingHttpHeaders): boolean {
  if (headers['transfer-encoding'] !== undefined)
    return false
  const length = headers['content-length']
  return length === undefined || length === '0'
}

export function negotiateEncoding(acceptEncoding: string | undefined, supportsZstd: boolean): 'zstd' | 'gzip' | 'identity' {
  const quality = parseQuality(acceptEncoding)
  if (quality.size === 0)
    return IDENTITY
  if (supportsZstd && qualityOf(quality, 'zstd') > 0)
    return 'zstd'
  return qualityOf(quality, 'gzip') > 0 ? 'gzip' : IDENTITY
}

export function acceptsEncoding(acceptEncoding: string | undefined, coding: string): boolean {
  const quality = parseQuality(acceptEncoding)
  if (quality.size === 0)
    return coding === IDENTITY
  return qualityOf(quality, coding) > 0
}

export function isCompressible(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === '')
    return false
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (type === '' || BINARY_TYPE.test(type))
    return false
  return !ARCHIVE_TYPE.test(type)
}

export function isEventStream(contentType: string | undefined): boolean {
  return contentType !== undefined && /^text\/event-stream\b/i.test(contentType.trim())
}

/** 响应体处理计划（S2 §8.2/§8.3）：上游编码可接受即原样透传；否则解压后按下游协商重压。 */
export function responsePlanOf(input: RemoteResponsePlanInput): RemoteResponsePlan {
  const streaming = isEventStream(input.contentType)
  const upstream = input.upstreamEncoding?.trim().toLowerCase()
  const encoded = upstream !== undefined && upstream !== '' && upstream !== IDENTITY
  const passthroughUpstream = encoded && acceptsEncoding(input.acceptEncoding, upstream)
  const plan: RemoteResponsePlan = { streaming, buffered: false }
  if (passthroughUpstream)
    return plan
  const decoded: RemoteResponsePlan = encoded ? { ...plan, decode: upstream } : plan
  if (!input.compress)
    return decoded
  const coding = isCompressible(input.contentType) ? negotiateEncoding(input.acceptEncoding, input.supportsZstd) : IDENTITY
  if (coding === IDENTITY)
    return decoded
  if (streaming || decoded.decode !== undefined)
    return { ...decoded, coding }
  if (input.contentLength !== undefined)
    return input.contentLength >= input.minBytes ? { ...decoded, coding } : decoded
  return { ...decoded, coding, buffered: true }
}

export function supportsZstd(): boolean {
  return typeof zlib.createZstdCompress === 'function'
}

/** SSE 逐块 flush：`flush: Z_SYNC_FLUSH` 使每次写入立即产出压缩块，不做任何聚合。 */
export function createCompressor(coding: 'zstd' | 'gzip', streaming: boolean): Transform {
  const options = streaming ? { flush: zlib.constants.Z_SYNC_FLUSH } : {}
  return coding === 'zstd' ? zlib.createZstdCompress(options) : zlib.createGzip(options)
}

export function createDecompressor(encoding: string): Transform | undefined {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'br':
      return zlib.createBrotliDecompress()
    case 'zstd':
      return typeof zlib.createZstdDecompress === 'function' ? zlib.createZstdDecompress() : undefined
    default:
      return undefined
  }
}

export function cookiePairsOf(setCookie: string[] | undefined): string[] {
  if (setCookie === undefined)
    return []
  return setCookie.map(pair => (pair.split(';')[0] ?? '').trim()).filter(pair => /^[^=;]+=[^;]*$/.test(pair))
}

export function mergeCookieHeader(existing: string | undefined, minted: string[]): string | undefined {
  const names = new Set(minted.map(pair => pair.slice(0, pair.indexOf('='))))
  const kept = (existing ?? '')
    .split(';')
    .map(pair => pair.trim())
    .filter(pair => pair !== '' && !names.has(pair.slice(0, pair.indexOf('='))))
  const merged = [...kept, ...minted]
  return merged.length === 0 ? undefined : merged.join('; ')
}

export function parseCookieHeader(value: string | undefined): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const segment of (value ?? '').split(';')) {
    const at = segment.indexOf('=')
    if (at === -1)
      continue
    const name = segment.slice(0, at).trim()
    if (name !== '')
      pairs.set(name, segment.slice(at + 1).trim())
  }
  return pairs
}

export function parseFormField(body: string, name: string): string | undefined {
  const value = new URLSearchParams(body).get(name)
  return value === null || value === '' ? undefined : value
}

/** 隧道侧声明的客户端 IP：只用于限速分桶，绝不参与放行判定（S2 §7.1）。 */
export function tunnelClientIpOf(headers: IncomingHttpHeaders): string | undefined {
  const direct = headers['cf-connecting-ip']
  const declared = typeof direct === 'string' ? direct.trim() : undefined
  if (isIpAddress(declared))
    return declared
  const forwarded = headers['x-forwarded-for']
  const first = (typeof forwarded === 'string' ? forwarded : '').split(',')[0]?.trim()
  return isIpAddress(first) ? first : undefined
}

export function loginPageHtml(message?: string): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>需要认证</title></head><body>',
    '<main><h1>需要认证</h1>',
    message === undefined ? '' : `<p>${escapeHtml(message)}</p>`,
    '<form method="post"><input type="password" name="password" autocomplete="current-password" placeholder="访问密码" autofocus>',
    '<button type="submit">进入</button></form></main>',
    '</body></html>',
  ].join('')
}

export function deniedHtml(reason: string): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>访问被拒绝</title></head><body>',
    `<main><h1>访问被拒绝</h1><p>${escapeHtml(reason)}</p></main>`,
    '</body></html>',
  ].join('')
}

// --- internal ---
function hostRewritten(kind: RemoteGatewayEntryKind, headers: IncomingHttpHeaders): boolean {
  if (kind !== 'tunnel')
    return false
  const host = headerText(headers.host)
  if (host === undefined || host === '')
    return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
    return bare === 'localhost' || bare.endsWith('.localhost') || classifyPeer(bare) === 'loopback'
  }
  catch {
    return false
  }
}

function reframeBody(incoming: IncomingHttpHeaders, out: OutgoingHttpHeaders): void {
  if (incoming['transfer-encoding'] !== undefined && incoming['transfer-encoding'] !== '') {
    out['transfer-encoding'] = 'chunked'
    return
  }
  const declared = headerText(incoming['content-length'])
  if (declared === undefined)
    return
  const length = Number(declared)
  if (Number.isInteger(length) && length >= 0)
    out['content-length'] = length
  else
    out['transfer-encoding'] = 'chunked'
}

function parseQuality(acceptEncoding: string | undefined): Map<string, number> {
  const quality = new Map<string, number>()
  if (acceptEncoding === undefined)
    return quality
  for (const entry of acceptEncoding.split(',')) {
    const [rawToken, ...parameters] = entry.split(';')
    const token = (rawToken ?? '').trim().toLowerCase()
    if (token === '')
      continue
    const rawQuality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='))
    const parsed = rawQuality === undefined ? 1 : Number(rawQuality.slice(2))
    quality.set(token, Number.isFinite(parsed) ? parsed : 0)
  }
  return quality
}

function qualityOf(quality: Map<string, number>, coding: string): number {
  return quality.get(coding) ?? quality.get('*') ?? 0
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
