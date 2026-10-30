import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import * as sdk from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { desktopMcpOAuth } from '../../../../../apps/desktop/src-tauri/src/service/patch/mcp_oauth.mjs'

const fixtures = []
const pending = []
const secret = 'access_token=private-access refresh_token=private-refresh client_secret=private-client code_verifier=private-verifier'
const registrationFailure = 'MCP OAuth client registration failed (HTTP 403). The server may require an approved MCP client.'

afterEach(async () => {
  try {
    for (const { api, started } of pending.splice(0)) {
      if (api.lookup(started.attemptId)?.status !== 'pending')
        continue
      const callback = callbackUrl(started)
      callback.searchParams.delete('code')
      callback.searchParams.set('error', 'access_denied')
      expect((await fetch(callback)).status).toBe(400)
    }
  }
  finally {
    await Promise.all(fixtures.splice(0).map(async (fixture) => {
      await fixture.close()
      expect(fixture.errors).toEqual([])
    }))
  }
})

function credentials() {
  const records = new Map()
  const locks = new Map()
  return {
    records,
    async readRecord(key) {
      return structuredClone(records.get(key))
    },
    modifyRecord(key, update) {
      const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
        const next = await update(structuredClone(records.get(key)))
        if (next !== undefined)
          records.set(key, structuredClone(next))
        return structuredClone(records.get(key))
      })
      locks.set(key, run.catch(() => {}))
      return run
    },
  }
}

async function fixture(options = {}) {
  const requests = []
  const errors = []
  let origin
  let registration
  let challenge
  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req)
        raw += chunk
      const url = new URL(req.url, origin)
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw })
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        reply(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['tools:read'] })
        return
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        reply(res, options.metadataStatus ?? 200, options.metadataStatus
          ? { error: secret }
          : {
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              token_endpoint_auth_methods_supported: ['none'],
              code_challenge_methods_supported: ['S256'],
              authorization_response_iss_parameter_supported: true,
            })
        return
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        registration = JSON.parse(raw)
        reply(res, options.registrationStatus ?? 201, options.registrationStatus ? { error: 'invalid_client_metadata', error_description: secret } : { ...registration, client_id: 'local-desktop' })
        return
      }
      if (url.pathname === '/authorize' && req.method === 'GET') {
        challenge = url.searchParams.get('code_challenge')
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.searchParams.set('state', url.searchParams.get('state'))
        callback.searchParams.set('code', 'valid-local-code')
        callback.searchParams.set('iss', origin)
        res.writeHead(302, { Location: callback.href }).end()
        return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(raw)
        const verifier = params.get('code_verifier')
        const actual = createHash('sha256').update(verifier ?? '').digest('base64url')
        if (params.get('grant_type') !== 'authorization_code' || params.get('code') !== 'valid-local-code' || params.get('client_id') !== 'local-desktop' || params.get('redirect_uri') !== registration.redirect_uris[0] || !challenge || actual !== challenge) {
          reply(res, 400, { error: 'invalid_grant' })
          return
        }
        reply(res, options.tokenStatus ?? 200, options.tokenStatus ? { error: 'server_error', error_description: secret } : { access_token: 'local-access', refresh_token: 'local-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'tools:read' })
        return
      }
      if (url.pathname === '/mcp') {
        if (req.headers.authorization !== 'Bearer local-access') {
          reply(res, 401, { error: 'authorization_required' }, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools:read"` })
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { error: 'method_not_allowed' })
          return
        }
        const message = JSON.parse(raw)
        if (message.method === 'initialize') {
          reply(res, options.initializationStatus ?? 200, options.initializationStatus ? { error: secret } : { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'local-mcp', version: '1' } } })
          return
        }
        if (message.method === 'server/discover') {
          reply(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        if (message.method === 'notifications/initialized') {
          res.writeHead(202).end()
          return
        }
      }
      reply(res, 404, { error: 'not_found' })
    }
    catch (error) {
      errors.push(error.message)
      reply(res, 500, { error: 'fixture_error' })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  const value = {
    origin,
    requests,
    errors,
    row: { serverName: 'local-oauth', transport: 'streamable-http', url: `${origin}/mcp` },
    get registration() { return registration },
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
  fixtures.push(value)
  return value
}

async function start(fixture) {
  const store = credentials()
  const api = desktopMcpOAuth(sdk, store)
  const started = await api.start(fixture.row)
  pending.push({ api, started })
  return { api, started, store }
}

function callbackUrl(started) {
  const authorization = new URL(started.authorizationUrl)
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', authorization.searchParams.get('state'))
  callback.searchParams.set('code', 'valid-local-code')
  callback.searchParams.set('iss', authorization.origin)
  return callback
}

function expectPrivate(value) {
  const text = JSON.stringify(value)
  for (const marker of ['private-access', 'private-refresh', 'private-client', 'private-verifier'])
    expect(text).not.toContain(marker)
}

it('reports real SDK registration rejection with a safe actionable error instead of a generic startup failure', async () => {
  const local = await fixture({ registrationStatus: 403 })
  const store = credentials()
  const api = desktopMcpOAuth(sdk, store)
  const error = await api.start(local.row).then((started) => {
    pending.push({ api, started })
    return started
  }, error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: 'MCP_OAUTH_START_FAILED', message: registrationFailure })
  expect(error).not.toHaveProperty('cause')
  expectPrivate({ ...error, message: error.message, stack: error.stack })
  expect(local.requests.map(request => `${request.method} ${request.path}`)).toEqual([
    'POST /mcp',
    'GET /.well-known/oauth-protected-resource',
    'GET /.well-known/oauth-authorization-server',
    'POST /register',
  ])
  expect(local.registration).toMatchObject({ client_name: 'DSH Desktop', application_type: 'native', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'tools:read' })
  expect(local.registration.redirect_uris).toHaveLength(1)
  expect(local.registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  expect(store.records.size).toBe(0)
})

it('reports authorization server metadata HTTP failures without exposing server text or endpoint URLs', async () => {
  const local = await fixture({ metadataStatus: 503 })
  const api = desktopMcpOAuth(sdk, credentials())
  const error = await api.start(local.row).then((started) => {
    pending.push({ api, started })
    return started
  }, error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: 'MCP_OAUTH_START_FAILED', message: 'MCP OAuth server discovery failed (HTTP 503)' })
  expect(error).not.toHaveProperty('cause')
  expectPrivate({ ...error, message: error.message, stack: error.stack })
  expect(error.message).not.toContain(local.origin)
  expect(local.requests.map(request => `${request.method} ${request.path}`)).toEqual([
    'POST /mcp',
    'GET /.well-known/oauth-protected-resource',
    'GET /.well-known/oauth-authorization-server',
  ])
})

it('completes real SDK discovery registration PKCE callback token exchange and MCP initialization before authorizing', async () => {
  const local = await fixture()
  const { api, started, store } = await start(local)
  const authorization = new URL(started.authorizationUrl)
  expect(authorization.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/)
  expect(authorization.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorization.searchParams.get('client_id')).toBe('local-desktop')
  expect(authorization.searchParams.get('resource')).toBe(local.row.url)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'pending' })
  const response = await fetch(authorization)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('MCP authorized. You can close this window.')
  expect(api.lookup(started.attemptId)).toEqual({ status: 'authorized' })
  const record = [...store.records.values()][0].payload
  expect(record.tokens).toMatchObject({ access_token: 'local-access', refresh_token: 'local-refresh', issuer: local.origin })
  expect(record.clientInformation).toMatchObject({ client_id: 'local-desktop', issuer: local.origin })
  expect(record.discovery.authorizationServerMetadata.issuer).toBe(local.origin)
  expect(record.redirectUrl).toBe(authorization.searchParams.get('redirect_uri'))
  expect(record).not.toHaveProperty('verifier')
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(1)
  const initialized = local.requests.filter(request => request.path === '/mcp' && request.method === 'POST' && request.headers.authorization === 'Bearer local-access').map(request => JSON.parse(request.body).method)
  expect(initialized).toContain('initialize')
  expect(initialized).toContain('notifications/initialized')
})

it('rejects wrong and duplicate callback state without consuming the real SDK authorization attempt', async () => {
  const local = await fixture()
  const { api, started } = await start(local)
  const callback = callbackUrl(started)
  callback.searchParams.set('state', 'incorrect')
  expect((await fetch(callback)).status).toBe(400)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'pending' })
  callback.searchParams.set('state', new URL(started.authorizationUrl).searchParams.get('state'))
  callback.searchParams.append('state', 'duplicate')
  expect((await fetch(callback)).status).toBe(400)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'pending' })
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(0)
  expect((await fetch(started.authorizationUrl)).status).toBe(200)
  expect(api.lookup(started.attemptId)).toEqual({ status: 'authorized' })
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(1)
})

it('never reports authorized when real SDK token exchange succeeds but MCP initialization fails', async () => {
  const local = await fixture({ initializationStatus: 500 })
  const { api, started } = await start(local)
  const response = await fetch(started.authorizationUrl)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('MCP authorization failed. Return to DSH for details.')
  const status = api.lookup(started.attemptId)
  expect(status).toEqual({ status: 'error', error: 'MCP initialization failed (HTTP 500)' })
  expectPrivate(status)
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(1)
})

it('reports authorization required instead of token failure when post-token MCP initialization still returns 401', async () => {
  const local = await fixture({ initializationStatus: 401 })
  const { api, started } = await start(local)
  const response = await fetch(started.authorizationUrl)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('MCP authorization failed. Return to DSH for details.')
  const status = api.lookup(started.attemptId)
  expect(status).toEqual({ status: 'error', error: 'MCP authorization required' })
  expectPrivate(status)
  const tokenGrants = local.requests.filter(request => request.path === '/token').map(request => new URLSearchParams(request.body).get('grant_type'))
  expect(tokenGrants).toEqual(['authorization_code', 'refresh_token'])
})

it('reports real SDK token exchange HTTP failures without exposing OAuth server error descriptions', async () => {
  const local = await fixture({ tokenStatus: 503 })
  const { api, started, store } = await start(local)
  const response = await fetch(started.authorizationUrl)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('MCP authorization failed. Return to DSH for details.')
  const status = api.lookup(started.attemptId)
  expect(status).toEqual({ status: 'error', error: 'MCP OAuth token exchange failed (HTTP 503)' })
  expectPrivate(status)
  expect(store.records.size).toBe(0)
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(1)
})

it('denies a real SDK callback without exchanging tokens or exposing callback error text', async () => {
  const local = await fixture()
  const { api, started, store } = await start(local)
  const callback = callbackUrl(started)
  callback.searchParams.delete('code')
  callback.searchParams.set('error', 'access_denied')
  callback.searchParams.set('error_description', secret)
  const response = await fetch(callback)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('MCP authorization failed. Return to DSH for details.')
  const status = api.lookup(started.attemptId)
  expect(status).toEqual({ status: 'error', error: 'OAuth authorization denied' })
  expectPrivate(status)
  expect(store.records.size).toBe(0)
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(0)
})

it('preserves callback issuer validation and never redeems a code from a mismatched issuer', async () => {
  const local = await fixture()
  const { api, started } = await start(local)
  const callback = callbackUrl(started)
  callback.searchParams.set('iss', 'https://attacker.invalid/private-access')
  const response = await fetch(callback)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('MCP authorization failed. Return to DSH for details.')
  const status = api.lookup(started.attemptId)
  expect(status).toEqual({ status: 'error', error: 'MCP OAuth authorization server validation failed' })
  expectPrivate(status)
  expect(JSON.stringify(status)).not.toContain('attacker.invalid')
  expect(local.requests.filter(request => request.path === '/token')).toHaveLength(0)
})
