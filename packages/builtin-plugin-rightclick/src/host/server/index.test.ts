import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '.'

const P = '/api/tauri/rightclick'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', `${P}/open/url`],
  ['POST', `${P}/open/path`],
]

interface Harness {
  ctx: unknown
  registered: Map<string, WebRoute>
}

function createHarness(): Harness {
  const registered = new Map<string, WebRoute>()
  return {
    registered,
    ctx: {
      webServer: {
        register(route: WebRoute): () => void {
          const key = routeKey(route.kind, route.path)
          if (registered.has(key))
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          registered.set(key, route)
          return () => {
            registered.delete(key)
          }
        },
      },
      logger: { error: () => {} },
    } as unknown as Context,
  }
}

const disposers: Array<() => void> = []

function mount(harness: Harness): () => void {
  const dispose = server(harness.ctx as Context)
  disposers.push(dispose)
  return dispose
}

const servers: Server[] = []

async function listen(registered: Map<string, WebRoute>): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.get(routeKey('exact', pathname))
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function post(base: string, path: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('右键菜单路由声明', () => {
  it('按迁移前的路径与方法声明 2 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_ROUTES.map(([, path]) => routeKey('exact', path)).sort())

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('变更路由拒绝读方法（405 + allow 头）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [, path] of EXPECTED_ROUTES) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort(), path).toEqual('POST'.split(', ').sort())
    }

    dispose()
  })

  it('oPTIONS 未声明时返回 405 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/open/url`, { method: 'OPTIONS' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')?.split(', ').sort()).toEqual('POST'.split(', ').sort())

    dispose()
  })

  it('非 application/json 内容类型返回 415 unsupported-media-type', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [, path] of EXPECTED_ROUTES) {
      const response = await post(base, path, { url: 'https://example.com', path: 'C:\\workspace' }, 'text/plain')
      expect(response.status, path).toBe(415)
      expect(await response.json(), path).toEqual({ ok: false, error: 'unsupported-media-type' })
    }

    dispose()
  })

  it('open/url 只放行 http/https（其余 400 invalid-url）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const url of ['', 'file:///etc/passwd', 'javascript:alert(1)', 42, undefined]) {
      const response = await post(base, `${P}/open/url`, { url })
      expect(response.status, String(url)).toBe(400)
      expect(await response.json(), String(url)).toEqual({ ok: false, error: 'invalid-url' })
    }

    dispose()
  })

  it('open/path 只放行本地路径（空值与 URL scheme 一律 400 invalid-path）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const path of ['', '   ', 'https://example.com', 'file:///C:/workspace', 42, undefined]) {
      const response = await post(base, `${P}/open/path`, { path })
      expect(response.status, String(path)).toBe(400)
      expect(await response.json(), String(path)).toEqual({ ok: false, error: 'invalid-path' })
    }

    dispose()
  })
})
