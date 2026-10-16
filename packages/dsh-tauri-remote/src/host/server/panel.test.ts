import type { HostWebRoute } from '../types/index'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_SESSION_HEADER, GATEWAY_SOURCE_HEADER } from '../config/constants'
import { ensureSourceSession, setHostConfig } from '../config/runtime'
import { access } from '../service/access'
import { server } from './index'
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
let previousHome: string | undefined

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
  previousHome = process.env.DSH_HOME
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
  const context = {
    webServer: {
      register: (route: HostWebRoute) => {
        registered.push(route)
        return () => {
          registered.splice(registered.indexOf(route), 1)
        }
      },
    },
    logger: { error: () => {} },
  } as never
  const disposeServer = server(context)
  const disposePanel = panel(context)
  disposeRoutes = () => {
    disposePanel()
    disposeServer()
  }
  const listener = await serveRoutes()
  origin = listener.origin
  closeServer = listener.close
})

beforeEach(() => {
  vi.stubEnv('DSH_REMOTE_SESSION_ORIGIN', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  disposeRoutes()
  await closeServer()
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = previousHome
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

describe('远端路由（真实注册 + HTTP）', () => {
  it('只把入站分享与完整凭据管理挂到 /access 下', () => {
    expect(registered.filter(route => route.path.startsWith(`${BASE}/access`)).map(route => `${route.kind} ${route.path}`)).toEqual([
      `exact ${BASE}/access`,
      `exact ${BASE}/access/tunnel`,
      `exact ${BASE}/access/token`,
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

  it('非回环来源禁止读取状态且不进入凭据管理服务', async () => {
    const status = vi.spyOn(access, 'status')
    const response = await call('GET', `${BASE}/access`, PUBLIC_SOURCE)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: LOOPBACK_ONLY_ERROR })
    expect(status).not.toHaveBeenCalled()
  })

  it('公网来源的写操作一律 403，且不进入 handler', async () => {
    for (const [method, path] of [['POST', `${BASE}/access`], ['POST', `${BASE}/access/token`], ['DELETE', `${BASE}/access/token`], ['POST', `${BASE}/access/tunnel`], ['DELETE', `${BASE}/access/tunnel`]] as const) {
      const response = await call(method, path, PUBLIC_SOURCE)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(response.body, `${method} ${path}`).toEqual({ error: LOOPBACK_ONLY_ERROR })
    }
  })

  it('永久码管理拒绝可信远程、伪造回环与远程进程标记且不轮换凭据', async () => {
    const rotate = vi.spyOn(access, 'rotate')
    const revoke = vi.spyOn(access, 'revoke')
    const sources: Record<string, string>[] = [
      ...['private', 'public', 'tunnel'].map(source => ({ [GATEWAY_SOURCE_HEADER]: source, [GATEWAY_SESSION_HEADER]: ensureSourceSession() })),
      { [GATEWAY_SOURCE_HEADER]: 'loopback', [GATEWAY_SESSION_HEADER]: 'forged' },
      { [GATEWAY_SOURCE_HEADER]: 'loopback' },
      { [GATEWAY_SESSION_HEADER]: ensureSourceSession() },
      { [GATEWAY_SOURCE_HEADER]: 'public', [GATEWAY_SESSION_HEADER]: 'outbound' },
    ]
    for (const headers of sources) {
      for (const method of ['POST', 'DELETE']) {
        const response = await call(method, `${BASE}/access/token`, headers)
        expect(response.status).toBe(403)
        expect(response.body).toEqual({ error: LOOPBACK_ONLY_ERROR })
      }
    }
    vi.stubEnv('DSH_REMOTE_SESSION_ORIGIN', 'ops')
    expect((await call('POST', `${BASE}/access/token`)).status).toBe(403)
    expect((await call('DELETE', `${BASE}/access/token`)).status).toBe(403)
    expect(rotate).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('回环来源的写操作进入 handler 并按 DTO 校验报 400', async () => {
    const response = await call('POST', `${BASE}/access`, {}, { port: 'not-a-port' })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: expect.stringContaining('port') })
  })
})
