import type { HostWebRoute } from '../types/index'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GATEWAY_SOURCE_HEADER } from '../config/constants'
import { setHostConfig } from '../config/runtime'
import { panel } from './panel'
import { LOOPBACK_ONLY_ERROR } from './panel.utils'

const BASE = '/api/tauri/remote'

const PUBLIC_SOURCE = {
  [GATEWAY_SOURCE_HEADER]: 'public',
  'x-forwarded-for': '203.0.113.7',
}

const registered: HostWebRoute[] = []
let origin = ''
let disposeRoutes: () => void
let closeServer: () => Promise<void>
let home = ''

function serveRoutes(): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.find(entry => entry.path === path)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"no-route"}')
      return
    }
    void route.handler(request, response)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        origin: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-panel-'))
  process.env.DSH_HOME = home
  setHostConfig({
    connectTimeoutMs: 15_000,
    healthCheckTimeoutMs: 1_000,
    healthPollIntervalMs: 5,
    healthPollAttempts: 3,
    keepaliveIntervalMs: 10_000,
    keepaliveCountMax: 3,
    reconnectInitialDelayMs: 1,
    reconnectMaxDelayMs: 2,
    reconnectMaxAttempts: 2,
    sshDir: join(home, 'ssh'),
  })
  disposeRoutes = panel({
    webServer: {
      register: (route: HostWebRoute) => {
        registered.push(route)
        return () => {
          registered.splice(registered.indexOf(route), 1)
        }
      },
    },
    logger: { error: () => {} },
  } as never)
  const listener = await serveRoutes()
  origin = listener.origin
  closeServer = listener.close
})

afterAll(async () => {
  disposeRoutes()
  await closeServer()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number, body: Record<string, unknown>, allow: string | undefined }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...headers,
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
    allow: response.headers.get('allow') ?? undefined,
  }
}

describe('面板专用路由（真实注册 + HTTP）', () => {
  it('只在独立 panel 注册表里挂三条面板路径', () => {
    expect(registered.map(route => `${route.kind} ${route.path}`)).toEqual([
      `exact ${BASE}/access`,
      `exact ${BASE}/access/token`,
      `exact ${BASE}/access/tunnel`,
    ])
  })

  it('声明每条面板路径的方法集', async () => {
    expect((await call('OPTIONS', `${BASE}/access`)).allow).toBe('GET, POST, HEAD')
    expect((await call('OPTIONS', `${BASE}/access/token`)).allow).toBe('POST, DELETE')
    expect((await call('OPTIONS', `${BASE}/access/tunnel`)).allow).toBe('POST, DELETE')
  })

  it('回环来源可读完整状态', async () => {
    const response = await call('GET', `${BASE}/access`)
    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('state')
  })

  it('非回环来源可读但拿不到凭据与链接', async () => {
    const response = await call('GET', `${BASE}/access`, PUBLIC_SOURCE)
    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('link')
    expect(response.body).not.toHaveProperty('qr')
    expect(response.body.auth).toMatchObject({ hasPassword: false, hasToken: false })
  })

  it('公网来源的写操作一律 403，且不进入 handler', async () => {
    for (const [method, path] of [['POST', `${BASE}/access`], ['POST', `${BASE}/access/token`], ['DELETE', `${BASE}/access/token`], ['POST', `${BASE}/access/tunnel`], ['DELETE', `${BASE}/access/tunnel`]] as const) {
      const response = await call(method, path, PUBLIC_SOURCE)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(response.body, `${method} ${path}`).toEqual({ error: LOOPBACK_ONLY_ERROR })
    }
  })

  it('回环来源的写操作进入 handler 并按 DTO 校验报 400', async () => {
    const response = await call('POST', `${BASE}/access`, {}, { port: 'not-a-port' })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: expect.stringContaining('port') })
  })
})
