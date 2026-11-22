import type { IncomingMessage, Server } from 'node:http'
import type { McpAuthBackend, McpAuthCredentialStore, McpOAuthGrant, McpOAuthSdk } from './mcp-auth.types'
import type { McpRow } from './mcp.types'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import * as clientSdk from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpAuthBackend } from './mcp-auth.backend'

const sdk = clientSdk as unknown as McpOAuthSdk

const ACCESS_TOKEN = 'access-1'

interface FakeServer {
  url: string
  requests: string[]
  rotate: () => void
  close: () => Promise<void>
}

const running: FakeServer[] = []

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function startServer(options: { requireAuth: boolean, metadata?: boolean }): Promise<FakeServer> {
  const requests: string[] = []
  let access = ACCESS_TOKEN
  let base = ''
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', base)
    requests.push(`${req.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        res.writeHead(405).end()
        return
      }
      if (options.requireAuth && req.headers.authorization !== `Bearer ${access}`) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}.well-known/oauth-protected-resource"` }).end()
        return
      }
      const message = JSON.parse(body) as { id?: number, method?: string, params?: { protocolVersion?: string } }
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: message.params?.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
        }))
        return
      }
      res.writeHead(202).end()
      return
    }
    if (!options.metadata) {
      res.writeHead(404).end('not found')
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ resource: `${base}mcp`, authorization_servers: [base] }))
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}authorize`,
        token_endpoint: `${base}token`,
        registration_endpoint: `${base}register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }))
      return
    }
    if (url.pathname === '/register') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ client_id: 'client-1', redirect_uris: (JSON.parse(body) as { redirect_uris: string[] }).redirect_uris, token_endpoint_auth_method: 'none' }))
      return
    }
    if (url.pathname === '/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', 'code-1')
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: redirect.href }).end()
      return
    }
    if (url.pathname === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' }))
      return
    }
    res.writeHead(404).end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('fake server did not bind')
  base = `http://127.0.0.1:${address.port}/`
  const fake: FakeServer = {
    url: `${base}mcp`,
    requests,
    rotate: () => {
      access = `${access}-rotated`
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
  running.push(fake)
  return fake
}

function memoryStore(): McpAuthCredentialStore & { grants: Map<string, McpOAuthGrant> } {
  const grants = new Map<string, McpOAuthGrant>()
  return {
    grants,
    readRecord: async key => grants.has(key) ? { kind: 'grant', payload: grants.get(key) } : undefined,
    modifyRecord: async (key, mutate) => {
      const current = grants.has(key) ? { kind: 'grant', payload: grants.get(key) } : undefined
      const next = await mutate(current)
      if (next !== undefined)
        grants.set(key, next.payload as McpOAuthGrant)
      return next
    },
  }
}

async function completeAuthorization(backend: McpAuthBackend, authorizationUrl: string, attemptId: string): Promise<void> {
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' })
  expect(authorize.status).toBe(302)
  const callback = await fetch(authorize.headers.get('location') ?? '', { headers: { host: new URL(authorizationUrl).host } })
  expect(await callback.text()).toBe('MCP authorized. You can close this window.')
  await expect.poll(() => backend.lookup(attemptId)?.status, { timeout: 10_000 }).toBe('authorized')
}

function rowOf(url: string, headers?: Record<string, string>): McpRow {
  return { id: 'probe', serverName: 'probe', transport: 'streamable-http', disabled: false, url, ...(headers === undefined ? {} : { headers }) }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

describe('createMcpAuthBackend check', () => {
  it('reports ok for a reachable server', async () => {
    const fake = await startServer({ requireAuth: false })
    const backend = createMcpAuthBackend(sdk, memoryStore())
    await expect(backend.check(rowOf(fake.url), 5000)).resolves.toEqual({ ok: true })
  })

  it('keeps a bearer header usable without any stored grant', async () => {
    const fake = await startServer({ requireAuth: true, metadata: true })
    const backend = createMcpAuthBackend(sdk, memoryStore())
    await expect(backend.check(rowOf(fake.url, { Authorization: `Bearer ${ACCESS_TOKEN}` }), 5000)).resolves.toEqual({ ok: true })
  })

  it('asks for authorization when the server rejects the request', async () => {
    const fake = await startServer({ requireAuth: true, metadata: true })
    const backend = createMcpAuthBackend(sdk, memoryStore())
    await expect(backend.check(rowOf(fake.url), 5000)).resolves.toEqual({ ok: false, detail: 'MCP authorization required', requiresAuth: true })
  })

  it('reports the http status when the server fails without asking for authorization', async () => {
    const fake = await startServer({ requireAuth: false })
    const backend = createMcpAuthBackend(sdk, memoryStore())
    await expect(backend.check(rowOf(`${fake.url}/missing`), 5000)).resolves.toEqual({ ok: false, detail: 'MCP initialization failed (HTTP 404)' })
  })

  it('rejects rows that are not streamable http', async () => {
    const backend = createMcpAuthBackend(sdk, memoryStore())
    const stdioRow: McpRow = { id: 'stdio', serverName: 'stdio', transport: 'stdio', disabled: false, command: 'node' }
    await expect(backend.check(stdioRow, 5000)).resolves.toEqual({ ok: false, detail: 'OAuth requires a streamable HTTP server' })
  })
})

describe('createMcpAuthBackend start', () => {
  it('completes the authorization callback and stores the grant', async () => {
    const fake = await startServer({ requireAuth: true, metadata: true })
    const store = memoryStore()
    const backend = createMcpAuthBackend(sdk, store)
    const row = rowOf(fake.url)
    const started = await backend.start(row)
    expect(new URL(started.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256')
    expect(backend.lookup(started.attemptId)).toEqual({ status: 'pending' })

    await completeAuthorization(backend, started.authorizationUrl, started.attemptId)
    expect(store.grants.size).toBe(1)
    await expect(backend.check(row, 5000)).resolves.toEqual({ ok: true })
  })

  it('refreshes an expired access token instead of asking for a new authorization', async () => {
    const fake = await startServer({ requireAuth: true, metadata: true })
    const store = memoryStore()
    const backend = createMcpAuthBackend(sdk, store)
    const row = rowOf(fake.url)
    const started = await backend.start(row)
    await completeAuthorization(backend, started.authorizationUrl, started.attemptId)

    fake.rotate()
    await expect(backend.check(row, 5000)).resolves.toEqual({ ok: true })
    expect(fake.requests.filter(request => request === 'POST /token').length).toBe(2)
  })

  it('rejects a callback whose state does not match the attempt', async () => {
    const fake = await startServer({ requireAuth: true, metadata: true })
    const backend = createMcpAuthBackend(sdk, memoryStore())
    const started = await backend.start(rowOf(fake.url))
    const callback = new URL(started.authorizationUrl)
    const redirect = new URL(callback.searchParams.get('redirect_uri') ?? '')
    redirect.searchParams.set('code', 'code-1')
    redirect.searchParams.set('state', 'forged')
    const response = await fetch(redirect.href, { headers: { host: redirect.host } })
    expect(response.status).toBe(400)
    expect(backend.lookup(started.attemptId)).toEqual({ status: 'pending' })
  })

  it('forgets unknown attempts', async () => {
    const backend = createMcpAuthBackend(sdk, memoryStore())
    expect(backend.lookup('missing')).toBeUndefined()
  })
})
