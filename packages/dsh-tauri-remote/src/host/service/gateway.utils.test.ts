import type { IncomingHttpHeaders } from 'node:http'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { GATEWAY_SESSION_HEADER, GATEWAY_SOURCE_HEADER } from '../config/constants'
import { acceptsEncoding, authorityFor, cookiePairsOf, createCompressor, createDecompressor, entryUrlOf, forwardHeadersOf, isCompressible, isCrossSiteRequest, isEventStream, isNavigationRequest, isReplayable, isUpgradeOf, loginPageHtml, mergeCookieHeader, negotiateEncoding, parseCookieHeader, parseFormField, responseHeadersOf, responsePlanOf, supportsZstd, tunnelClientIpOf, upstreamPortOf } from './gateway.utils'

const SESSION = 'gateway-session-token'

async function roundTrip(coding: 'zstd' | 'gzip', streaming: boolean, payload: string): Promise<string> {
  const compressor = createCompressor(coding, streaming)
  const decompressor = createDecompressor(coding)
  expect(decompressor).toBeDefined()
  const compressed: Buffer[] = []
  await pipeline(Readable.from([Buffer.from(payload)]), compressor, async function* (source) {
    for await (const chunk of source)
      compressed.push(chunk as Buffer)
  })
  const restored: Buffer[] = []
  await pipeline(Readable.from(compressed), decompressor as NodeJS.ReadWriteStream, async function* (source) {
    for await (const chunk of source)
      restored.push(chunk as Buffer)
  })
  return Buffer.concat(restored).toString('utf8')
}

describe('authorityFor', () => {
  it('uses the gateway loopback port for the outbound leg', () => {
    expect(authorityFor('outbound', new URL('http://127.0.0.1:39001'), 3088)).toBe('127.0.0.1:3088')
  })

  it('uses the upstream authority for the inbound and tunnel legs', () => {
    expect(authorityFor('inbound', new URL('http://127.0.0.1:3080'), 3088)).toBe('127.0.0.1:3080')
    expect(authorityFor('tunnel', new URL('http://127.0.0.1:3080'), 3088)).toBe('127.0.0.1:3080')
    expect(authorityFor('inbound', new URL('http://[::1]:3080'), 3088)).toBe('[::1]:3080')
  })
})

describe('entryUrlOf / upstreamPortOf', () => {
  it('builds the entry URL with the real port and brackets IPv6 hosts', () => {
    expect(entryUrlOf('127.0.0.1', 3088)).toBe('http://127.0.0.1:3088')
    expect(entryUrlOf('0.0.0.0', 3089)).toBe('http://0.0.0.0:3089')
    expect(entryUrlOf('fd00::1', 3088)).toBe('http://[fd00::1]:3088')
  })

  it('defaults an upstream URL without an explicit port to 80', () => {
    expect(upstreamPortOf(new URL('http://127.0.0.1:39001'))).toBe(39001)
    expect(upstreamPortOf(new URL('http://127.0.0.1'))).toBe(80)
  })
})

describe('forwardHeadersOf', () => {
  const headers: IncomingHttpHeaders = {
    'host': '192.168.1.5:3088',
    'origin': 'http://192.168.1.5:3088',
    'cookie': 'browser=1',
    'accept': 'text/html',
    'connection': 'keep-alive',
    'x-forwarded-for': '203.0.113.7',
  }

  it('rewrites Host and Origin to the forwarding authority', () => {
    const out = forwardHeadersOf(headers, { authority: '127.0.0.1:3080' })
    expect(out.host).toBe('127.0.0.1:3080')
    expect(out.origin).toBe('http://127.0.0.1:3080')
  })

  it('leaves an absent Origin absent', () => {
    const out = forwardHeadersOf({ host: '127.0.0.1:3088' }, { authority: '127.0.0.1:3080' })
    expect(out.origin).toBeUndefined()
  })

  it('drops hop-by-hop headers on the plain path and keeps them on the upgrade path', () => {
    expect(forwardHeadersOf(headers, { authority: '127.0.0.1:3080' }).connection).toBeUndefined()
    const upgrade = forwardHeadersOf({ ...headers, upgrade: 'websocket', connection: 'Upgrade' }, { authority: '127.0.0.1:3080', upgrade: true })
    expect(upgrade.connection).toBe('Upgrade')
    expect(upgrade.upgrade).toBe('websocket')
  })

  it('injects both internal markers on the forwarding legs', () => {
    const out = forwardHeadersOf(headers, { authority: '127.0.0.1:3080', source: 'private', session: SESSION })
    expect(out[GATEWAY_SOURCE_HEADER]).toBe('private')
    expect(out[GATEWAY_SESSION_HEADER]).toBe(SESSION)
  })

  it('replaces client-supplied markers instead of appending to them', () => {
    const forged: IncomingHttpHeaders = { ...headers, [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: 'forged' }
    const out = forwardHeadersOf(forged, { authority: '127.0.0.1:3080', source: 'public', session: SESSION })
    expect(out[GATEWAY_SOURCE_HEADER]).toBe('public')
    expect(out[GATEWAY_SESSION_HEADER]).toBe(SESSION)
    const multi = forwardHeadersOf({ ...forged, [GATEWAY_SOURCE_HEADER]: ['loopback', 'private'] }, { authority: '127.0.0.1:3080', source: 'public', session: SESSION })
    expect(multi[GATEWAY_SOURCE_HEADER]).toBe('public')
  })

  it('strips both markers when the leg must not inject them', () => {
    const forged: IncomingHttpHeaders = { ...headers, [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: SESSION }
    const out = forwardHeadersOf(forged, { authority: '127.0.0.1:3088', identity: true })
    expect(out[GATEWAY_SOURCE_HEADER]).toBeUndefined()
    expect(out[GATEWAY_SESSION_HEADER]).toBeUndefined()
    expect(out['accept-encoding']).toBe('identity')
  })

  it('keeps the session out of an upgrade forwarded on the outbound leg', () => {
    const out = forwardHeadersOf({ ...headers, upgrade: 'websocket' }, { authority: '127.0.0.1:3088', upgrade: true, identity: true })
    expect(Object.keys(out)).not.toContain(GATEWAY_SESSION_HEADER)
    expect(JSON.stringify(out)).not.toContain(SESSION)
  })

  it('重新宣告正文分帧：上游只声明了 transfer-encoding 时改写为分块，绝不留下无分帧的裸正文', () => {
    const chunked = forwardHeadersOf({ 'host': '127.0.0.1:3088', 'transfer-encoding': 'chunked' }, { authority: '127.0.0.1:3080' })
    expect(chunked['transfer-encoding']).toBe('chunked')
    expect(chunked['content-length']).toBeUndefined()
  })

  it('正文长度已知时保留 content-length，不额外声明分块', () => {
    const sized = forwardHeadersOf({ 'host': '127.0.0.1:3088', 'content-length': '12' }, { authority: '127.0.0.1:3080' })
    expect(sized['content-length']).toBe(12)
    expect(sized['transfer-encoding']).toBeUndefined()
    const empty = forwardHeadersOf({ 'host': '127.0.0.1:3088', 'content-length': '0' }, { authority: '127.0.0.1:3080' })
    expect(empty['content-length']).toBe(0)
    expect(empty['transfer-encoding']).toBeUndefined()
  })

  it('无正文声明的请求不凭空添上分块，升级路径原样透传分帧头', () => {
    const plain = forwardHeadersOf({ host: '127.0.0.1:3088' }, { authority: '127.0.0.1:3080' })
    expect(plain['transfer-encoding']).toBeUndefined()
    expect(plain['content-length']).toBeUndefined()
    const upgrade = forwardHeadersOf({ 'host': '127.0.0.1:3088', 'transfer-encoding': 'chunked' }, { authority: '127.0.0.1:3080', upgrade: true })
    expect(upgrade['transfer-encoding']).toBe('chunked')
  })
})

describe('responseHeadersOf', () => {
  it('keeps end-to-end headers and drops hop-by-hop ones', () => {
    const out = responseHeadersOf({ 'content-type': 'text/plain', 'content-length': '12', 'connection': 'keep-alive', 'transfer-encoding': 'chunked', 'set-cookie': ['a=1'] })
    expect(out).toEqual({ 'content-type': 'text/plain', 'content-length': '12', 'set-cookie': ['a=1'] })
  })
})

describe('request shape predicates', () => {
  it('detects an upgrade request through either marker', () => {
    expect(isUpgradeOf({ upgrade: 'websocket' })).toBe(true)
    expect(isUpgradeOf({ connection: 'keep-alive, Upgrade' })).toBe(true)
    expect(isUpgradeOf({ connection: 'keep-alive' })).toBe(false)
    expect(isUpgradeOf({})).toBe(false)
  })

  it('detects a navigation request by its Accept header', () => {
    expect(isNavigationRequest({ accept: 'text/html,application/xhtml+xml' })).toBe(true)
    expect(isNavigationRequest({ accept: '*/*' })).toBe(false)
    expect(isNavigationRequest({})).toBe(false)
  })

  it('treats only body-less requests as replayable', () => {
    expect(isReplayable({})).toBe(true)
    expect(isReplayable({ 'content-length': '0' })).toBe(true)
    expect(isReplayable({ 'content-length': '10' })).toBe(false)
    expect(isReplayable({ 'transfer-encoding': 'chunked' })).toBe(false)
  })

  it('flags cross-site initiators by Sec-Fetch-Site or by an Origin outside the request authority', () => {
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'sec-fetch-site': 'cross-site' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { host: '127.0.0.1:3088', origin: 'https://evil.example' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { host: '127.0.0.1:3088', origin: 'null' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { host: '127.0.0.1:3088', origin: 'http://127.0.0.1:3089' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'origin': 'http://127.0.0.1:3088', 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'sec-fetch-site': 'none' })).toBe(false)
    expect(isCrossSiteRequest('inbound', { 'host': 's2.trycloudflare.com', 'origin': 'https://s2.trycloudflare.com', 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(isCrossSiteRequest('inbound', { host: 's2.trycloudflare.com', origin: 'http://127.0.0.1:3088' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'websocket' })).toBe(true)
    expect(isCrossSiteRequest('inbound', { 'host': '127.0.0.1:3088', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBe(false)
  })

  it('keeps the tunnel leg usable when cloudflared rewrites Host to a loopback authority', () => {
    const rewritten = { 'host': '127.0.0.1:38999', 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin' }
    expect(isCrossSiteRequest('tunnel', rewritten)).toBe(false)
    expect(isCrossSiteRequest('inbound', rewritten)).toBe(true)
    expect(isCrossSiteRequest('outbound', rewritten)).toBe(true)
    expect(isCrossSiteRequest('tunnel', { 'host': 'localhost:38999', 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(isCrossSiteRequest('tunnel', { 'host': '[::1]:38999', 'origin': 'https://s2-probe.trycloudflare.com', 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(isCrossSiteRequest('inbound', { host: 'localhost:38999', origin: 'https://s2-probe.trycloudflare.com' })).toBe(true)
  })

  it('rejects same-site and headerless non-navigation requests once Host is rewritten', () => {
    const base = { 'host': '127.0.0.1:38999', 'origin': 'https://evil.trycloudflare.com', 'sec-fetch-mode': 'cors' }
    expect(isCrossSiteRequest('tunnel', { ...base, 'sec-fetch-site': 'same-site' })).toBe(true)
    expect(isCrossSiteRequest('tunnel', base)).toBe(true)
    expect(isCrossSiteRequest('tunnel', { ...base, 'sec-fetch-site': 'none' })).toBe(false)
    expect(isCrossSiteRequest('tunnel', { ...base, 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(isCrossSiteRequest('tunnel', { ...base, 'sec-fetch-site': 'cross-site' })).toBe(true)
    expect(isCrossSiteRequest('tunnel', { 'host': '127.0.0.1:38999', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' })).toBe(false)
    expect(isCrossSiteRequest('tunnel', { 'host': '127.0.0.1:38999', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBe(false)
  })

  it('still compares Origin against Host on the tunnel leg while the tunnel domain survives', () => {
    expect(isCrossSiteRequest('tunnel', { host: 's2-probe.trycloudflare.com', origin: 'https://s2-probe.trycloudflare.com' })).toBe(false)
    expect(isCrossSiteRequest('tunnel', { host: 's2-probe.trycloudflare.com', origin: 'https://evil.example' })).toBe(true)
    expect(isCrossSiteRequest('tunnel', { 'host': 's2-probe.trycloudflare.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toBe(true)
    expect(isCrossSiteRequest('tunnel', { 'host': 's2-probe.trycloudflare.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBe(false)
  })
})

describe('negotiateEncoding', () => {
  it('prefers zstd, then gzip, then identity', () => {
    expect(negotiateEncoding('gzip, zstd', true)).toBe('zstd')
    expect(negotiateEncoding('gzip, zstd', false)).toBe('gzip')
    expect(negotiateEncoding('gzip', true)).toBe('gzip')
    expect(negotiateEncoding('identity', true)).toBe('identity')
    expect(negotiateEncoding(undefined, true)).toBe('identity')
    expect(negotiateEncoding('', true)).toBe('identity')
  })

  it('falls back to identity when the client only accepts an unsupported coding', () => {
    expect(negotiateEncoding('br', true)).toBe('identity')
    expect(negotiateEncoding('br, deflate', true)).toBe('identity')
  })

  it('honours explicit quality values and the wildcard', () => {
    expect(negotiateEncoding('zstd;q=0, gzip', true)).toBe('gzip')
    expect(negotiateEncoding('*', true)).toBe('zstd')
    expect(negotiateEncoding('*;q=0', true)).toBe('identity')
    expect(negotiateEncoding('zstd;q=0.5, gzip;q=0.9', true)).toBe('zstd')
  })
})

describe('acceptsEncoding', () => {
  it('reports what the client declared', () => {
    expect(acceptsEncoding('gzip', 'gzip')).toBe(true)
    expect(acceptsEncoding('zstd, gzip', 'gzip')).toBe(true)
    expect(acceptsEncoding('zstd', 'gzip')).toBe(false)
    expect(acceptsEncoding('*', 'gzip')).toBe(true)
    expect(acceptsEncoding('gzip;q=0', 'gzip')).toBe(false)
    expect(acceptsEncoding(undefined, 'identity')).toBe(true)
    expect(acceptsEncoding(undefined, 'gzip')).toBe(false)
  })
})

describe('isCompressible / isEventStream', () => {
  it.each(['text/html; charset=utf-8', 'application/json', 'text/plain', 'text/javascript', 'application/javascript', 'text/event-stream'])('compresses %s', (type) => {
    expect(isCompressible(type)).toBe(true)
  })

  it.each(['image/png', 'image/svg+xml', 'audio/mpeg', 'video/mp4', 'font/woff2', 'application/zip', 'application/gzip', 'application/zstd', 'application/x-7z-compressed', 'application/x-tar'])('never compresses %s', (type) => {
    expect(isCompressible(type)).toBe(false)
  })

  it('never compresses an undeclared content type', () => {
    expect(isCompressible(undefined)).toBe(false)
    expect(isCompressible('')).toBe(false)
  })

  it('detects the streaming content type only', () => {
    expect(isEventStream('text/event-stream')).toBe(true)
    expect(isEventStream('text/event-stream; charset=utf-8')).toBe(true)
    expect(isEventStream('text/plain')).toBe(false)
    expect(isEventStream(undefined)).toBe(false)
  })
})

describe('responsePlanOf', () => {
  const base = { acceptEncoding: 'zstd, gzip', contentType: 'application/json', contentLength: 4096, upstreamEncoding: undefined, supportsZstd: true, compress: true, minBytes: 1024 }

  it('encodes a large compressible response with the negotiated coding', () => {
    expect(responsePlanOf(base)).toEqual({ streaming: false, buffered: false, coding: 'zstd' })
  })

  it('keeps a response below the threshold as identity', () => {
    expect(responsePlanOf({ ...base, contentLength: 1023 })).toEqual({ streaming: false, buffered: false })
    expect(responsePlanOf({ ...base, contentLength: undefined })).toEqual({ streaming: false, buffered: true, coding: 'zstd' })
  })

  it('never compresses a non-compressible type regardless of size', () => {
    expect(responsePlanOf({ ...base, contentType: 'image/png' })).toEqual({ streaming: false, buffered: false })
  })

  it('streams SSE without a size threshold', () => {
    expect(responsePlanOf({ ...base, contentType: 'text/event-stream', contentLength: undefined })).toEqual({ streaming: true, buffered: false, coding: 'zstd' })
    expect(responsePlanOf({ ...base, contentType: 'text/event-stream', contentLength: 10 })).toEqual({ streaming: true, buffered: false, coding: 'zstd' })
  })

  it('passes an upstream encoding through when the client accepts it', () => {
    expect(responsePlanOf({ ...base, upstreamEncoding: 'gzip' })).toEqual({ streaming: false, buffered: false })
    expect(responsePlanOf({ ...base, upstreamEncoding: 'gzip', acceptEncoding: 'zstd' })).toEqual({ streaming: false, buffered: false, decode: 'gzip', coding: 'zstd' })
  })

  it('decompresses without re-encoding when the client accepts no coding', () => {
    expect(responsePlanOf({ ...base, upstreamEncoding: 'gzip', acceptEncoding: 'identity' })).toEqual({ streaming: false, buffered: false, decode: 'gzip' })
    expect(responsePlanOf({ ...base, upstreamEncoding: 'gzip', contentType: 'image/png', acceptEncoding: 'zstd' })).toEqual({ streaming: false, buffered: false, decode: 'gzip' })
  })

  it('leaves the loopback leg on identity but still normalises an unacceptable upstream encoding', () => {
    expect(responsePlanOf({ ...base, compress: false })).toEqual({ streaming: false, buffered: false })
    expect(responsePlanOf({ ...base, compress: false, upstreamEncoding: 'gzip' })).toEqual({ streaming: false, buffered: false })
    expect(responsePlanOf({ ...base, compress: false, upstreamEncoding: 'gzip', acceptEncoding: 'zstd' })).toEqual({ streaming: false, buffered: false, decode: 'gzip' })
  })

  it('re-encodes a decoded body regardless of the encoded length, so a small gzip still becomes zstd', () => {
    expect(responsePlanOf({ ...base, upstreamEncoding: 'gzip', acceptEncoding: 'zstd', contentLength: 40 })).toEqual({ streaming: false, buffered: false, decode: 'gzip', coding: 'zstd' })
    expect(responsePlanOf({ ...base, upstreamEncoding: 'br', acceptEncoding: 'gzip', contentLength: undefined })).toEqual({ streaming: false, buffered: false, decode: 'br', coding: 'gzip' })
  })
})

describe('cookie helpers', () => {
  it('extracts the pair from each set-cookie header', () => {
    expect(cookiePairsOf(undefined)).toEqual([])
    expect(cookiePairsOf(['dsh_a=1; Path=/; HttpOnly', 'dsh_b=2; Max-Age=10'])).toEqual(['dsh_a=1', 'dsh_b=2'])
    expect(cookiePairsOf(['garbage'])).toEqual([])
  })

  it('parses a request cookie header into named pairs', () => {
    const pairs = parseCookieHeader('a=1; b=2; malformed; c=')
    expect(pairs.get('a')).toBe('1')
    expect(pairs.get('b')).toBe('2')
    expect(pairs.get('c')).toBe('')
    expect(pairs.get('malformed')).toBeUndefined()
    expect(parseCookieHeader(undefined).size).toBe(0)
  })

  it('keeps browser cookies and overrides same-named minted ones', () => {
    expect(mergeCookieHeader('keep=1; dsh_session=stale', ['dsh_session=fresh'])).toBe('keep=1; dsh_session=fresh')
    expect(mergeCookieHeader(undefined, ['dsh_session=fresh'])).toBe('dsh_session=fresh')
    expect(mergeCookieHeader('keep=1', [])).toBe('keep=1')
    expect(mergeCookieHeader(undefined, [])).toBeUndefined()
  })

  it('reads a urlencoded form field and ignores blanks', () => {
    expect(parseFormField('password=s3cret&next=%2F', 'password')).toBe('s3cret')
    expect(parseFormField('password=&next=%2F', 'password')).toBeUndefined()
    expect(parseFormField('next=%2F', 'password')).toBeUndefined()
  })
})

describe('tunnelClientIpOf', () => {
  it('prefers the Cloudflare client address and falls back to the first forwarded hop', () => {
    expect(tunnelClientIpOf({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })).toBe('203.0.113.7')
    expect(tunnelClientIpOf({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('203.0.113.7')
    expect(tunnelClientIpOf({ 'x-forwarded-for': '2001:db8::7' })).toBe('2001:db8::7')
  })

  it('reports nothing for a missing or malformed declaration', () => {
    expect(tunnelClientIpOf({})).toBeUndefined()
    expect(tunnelClientIpOf({ 'cf-connecting-ip': 'not-an-ip' })).toBeUndefined()
    expect(tunnelClientIpOf({ 'x-forwarded-for': 'unknown, 10.0.0.1' })).toBeUndefined()
  })
})

describe('compressors', () => {
  it('reports zstd support from the runtime API, never from a version guess', () => {
    expect(supportsZstd()).toBe(typeof zlib.createZstdCompress === 'function')
  })

  it('round-trips a payload through zstd and gzip', async () => {
    await expect(roundTrip('zstd', false, 'compressed payload')).resolves.toBe('compressed payload')
    await expect(roundTrip('gzip', false, 'compressed payload')).resolves.toBe('compressed payload')
  })

  it('round-trips a streaming payload', async () => {
    await expect(roundTrip('zstd', true, 'streamed payload')).resolves.toBe('streamed payload')
    await expect(roundTrip('gzip', true, 'streamed payload')).resolves.toBe('streamed payload')
  })

  it('never builds a decompressor for an unknown coding', () => {
    expect(createDecompressor('made-up')).toBeUndefined()
  })
})

describe('loginPageHtml', () => {
  it('posts the password back to the current URL without inventing another route', () => {
    const html = loginPageHtml()
    expect(html).toContain('<form method="post">')
    expect(html).toContain('name="password"')
    expect(html).not.toContain('action=')
  })

  it('renders and escapes the failure message', () => {
    const html = loginPageHtml('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('<script>x</script>')
  })
})
