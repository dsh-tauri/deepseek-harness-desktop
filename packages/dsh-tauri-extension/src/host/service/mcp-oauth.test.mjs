import { afterEach, expect, it, vi } from 'vitest'
import { desktopMcpOAuth } from '../../../../../src-tauri/src/service/patch/mcp_oauth.mjs'

const row = { serverName: 'figma', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer configured' } }
const stores = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const close of stores.splice(0))
    close()
})
function credentials(initial = {}) {
  let record = { kind: 'grant', payload: initial }
  let chain = Promise.resolve()
  return {
    keys: [],
    async readRecord(key) {
      if (key)
        this.keys.push(key)
      return structuredClone(record)
    },
    modifyRecord(key, update) {
      this.keys.push(key)
      const run = chain.then(async () => {
        record = await update(structuredClone(record)) ?? record
        return structuredClone(record)
      })
      chain = run.catch(() => {})
      return run
    },
  }
}
function sdk() {
  const transports = []
  class UnauthorizedError extends Error {}
  class StreamableHTTPClientTransport {
    constructor(url, options) {
      this.url = url
      this.options = options
      transports.push(this)
    }

    async close() {}
    async finishAuth(params) {
      expect(params.get('code')).toBe('valid-code')
      expect(await this.options.authProvider.codeVerifier()).toBe('pkce-verifier')
      await this.options.authProvider.saveTokens({ access_token: 'authorized', token_type: 'Bearer', expires_in: 3600 })
    }
  }
  class Client {
    async connect(transport) {
      this.transport = transport
      if (!await (transport.options.authProvider.token?.() ?? transport.options.authProvider.tokens?.())) {
        await transport.options.authProvider.saveCodeVerifier('pkce-verifier')
        const url = new URL('https://auth.example.test/authorize')
        url.searchParams.set('state', await transport.options.authProvider.state())
        url.searchParams.set('redirect_uri', transport.options.authProvider.redirectUrl)
        await transport.options.authProvider.redirectToAuthorization(url)
        throw new UnauthorizedError()
      }
    }

    async close() {}
  }
  return { Client, StreamableHTTPClientTransport, UnauthorizedError, transports, auth: vi.fn() }
}

it('refreshes rotating tokens under one credential lock and isolates endpoint identities', async () => {
  const store = credentials({ clientInformation: { client_id: 'desktop' }, tokens: { access_token: 'expired', refresh_token: 'rotate-once' }, expiresAt: 0 })
  const apiSdk = sdk()
  apiSdk.auth.mockImplementation(async (provider) => {
    expect((await provider.tokens()).refresh_token).toBe('rotate-once')
    await provider.saveTokens({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
    return 'AUTHORIZED'
  })
  const api = desktopMcpOAuth(apiSdk, store)
  const [a, b] = await Promise.all([api.provider(row).token(), api.provider(row).token()])
  expect(a).toBe('fresh')
  expect(b).toEqual(a)
  expect(apiSdk.auth).toHaveBeenCalledTimes(1)
  expect((await store.readRecord()).payload.tokens.refresh_token).toBe('rotated')
  await api.provider({ ...row, url: 'https://other.example.test/mcp' }).token()
  expect(new Set(store.keys).size).toBe(2)
})

it('does not expose refresh tokens to the transport SDK auth retry path', async () => {
  const api = desktopMcpOAuth(sdk(), credentials({ tokens: { access_token: 'current', refresh_token: 'secret' }, expiresAt: Date.now() + 3600000 }))
  expect(await api.provider(row).token()).toBe('current')
  expect(api.provider(row)).not.toHaveProperty('tokens')
})

it('rejects incorrect state without consuming callback and authorizes only after SDK initialization', async () => {
  const apiSdk = sdk()
  const api = desktopMcpOAuth(apiSdk, credentials())
  const started = await api.start(row)
  const authorization = new URL(started.authorizationUrl)
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  stores.push(() => fetch(`${callback}?state=${authorization.searchParams.get('state')}&error=access_denied`).catch(() => {}))
  callback.searchParams.set('code', 'valid-code')
  callback.searchParams.set('state', 'wrong')
  expect((await fetch(callback)).status).toBe(400)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'pending' })
  callback.searchParams.set('state', authorization.searchParams.get('state'))
  expect((await fetch(callback)).status).toBe(200)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'authorized' })
  expect(apiSdk.transports).toHaveLength(2)
  expect(apiSdk.transports[1].options.requestInit.headers).toEqual(row.headers)
})

it.each([401, 405, 500])('http %i never reports connected and only 401 requests authorization', async (status) => {
  const apiSdk = sdk()
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
  apiSdk.Client.prototype.connect = async function (transport) {
    this.transport = transport
    const response = await transport.options.fetch(transport.url, { method: 'POST', headers: transport.options.requestInit.headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize' }) })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
  }
  const result = await desktopMcpOAuth(apiSdk, credentials()).check(row)
  expect(result).toEqual({ ok: false, detail: status === 401 ? 'MCP authorization required' : `MCP initialization failed (HTTP ${status})`, ...(status === 401 ? { requiresAuth: true } : {}) })
  expect(request).toHaveBeenCalledWith(new URL(row.url), expect.objectContaining({ method: 'POST', headers: row.headers }))
})

it.each([{}, { tokens: { access_token: 'manual' } }, { tokens: { access_token: 'expired', refresh_token: 'rotate' } }])('silent unauthorized probes do not register OAuth clients without a refresh grant', async (record) => {
  const apiSdk = sdk()
  const provider = desktopMcpOAuth(apiSdk, credentials(record)).provider(row)
  await provider.token()
  await expect(provider.onUnauthorized({ response: new Response(null, { status: 401 }) })).rejects.toThrow('MCP authorization required')
  expect(apiSdk.auth).not.toHaveBeenCalled()
})

it('does not mark OAuth complete when post-authorization initialization fails', async () => {
  const apiSdk = sdk()
  const connect = apiSdk.Client.prototype.connect
  apiSdk.Client.prototype.connect = async function (transport) {
    await connect.call(this, transport)
    throw new Error('MCP initialize failed')
  }
  const api = desktopMcpOAuth(apiSdk, credentials())
  const started = await api.start(row)
  const url = new URL(started.authorizationUrl)
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', url.searchParams.get('state'))
  callback.searchParams.set('code', 'valid-code')
  expect((await fetch(callback)).status).toBe(400)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'error', error: 'MCP initialization failed' })
})

it('callback denial and expiration never produce authorized status', async () => {
  const api = desktopMcpOAuth(sdk(), credentials())
  const started = await api.start(row)
  const url = new URL(started.authorizationUrl)
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', url.searchParams.get('state'))
  callback.searchParams.set('error', 'access_denied')
  expect((await fetch(callback)).status).toBe(400)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'error', error: 'OAuth authorization denied' })
  vi.useFakeTimers()
  const expired = await api.start(row)
  await vi.advanceTimersByTimeAsync(300000)
  expect(api.lookup(expired.attemptId)).toEqual({ status: 'error', error: 'MCP authorization timed out' })
})
