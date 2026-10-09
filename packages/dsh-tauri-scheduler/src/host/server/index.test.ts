import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '.'

const P = '/api/tauri/scheduler'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/tasks`],
  ['POST', `${P}/tasks`],
  ['PUT', `${P}/tasks`],
  ['DELETE', `${P}/tasks`],
  ['POST', `${P}/tasks/toggle`],
  ['POST', `${P}/tasks/run`],
  ['GET', `${P}/history`],
  ['DELETE', `${P}/history`],
  ['GET', `${P}/options`],
  ['POST', `${P}/runs/recover`],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [`${P}/tasks`]: 'GET, HEAD, POST, PUT, DELETE',
  [`${P}/tasks/toggle`]: 'POST',
  [`${P}/tasks/run`]: 'POST',
  [`${P}/history`]: 'GET, HEAD, DELETE',
  [`${P}/options`]: 'GET, HEAD',
  [`${P}/runs/recover`]: 'POST',
}

const UNDECLARED_METHOD = 'PATCH'

interface Harness {
  registered: Map<string, WebRoute>
  ctx: Context
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

const servers: Server[] = []
const disposers: Array<() => void> = []

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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function sendJson(base: string, method: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function mount(harness: Harness): () => void {
  const dispose = server(harness.ctx)
  disposers.push(dispose)
  return dispose
}

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('调度器路由声明', () => {
  it('声明 10 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(EXPECTED_ROUTES).toHaveLength(10)
    expect(harness.registered.size).toBe(EXPECTED_PATHS.length)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法返回 405 + allow 头（每条路径与迁移前一致）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const path of EXPECTED_PATHS) {
      const response = await fetch(`${base}${path}`, { method: UNDECLARED_METHOD })
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort(), path).toEqual(ALLOW_BY_PATH[path].split(', ').sort())
    }

    dispose()
  })

  it('oPTIONS 未声明时返回 405 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const tasks = await fetch(`${base}${P}/tasks`, { method: 'OPTIONS' })
    expect(tasks.status).toBe(405)
    expect(tasks.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD, POST, PUT, DELETE'.split(', ').sort())

    const run = await fetch(`${base}${P}/tasks/run`, { method: 'OPTIONS' })
    expect(run.status).toBe(405)
    expect(run.headers.get('allow')?.split(', ').sort()).toEqual('POST'.split(', ').sort())

    dispose()
  })

  it('缺 id 的写路由返回 400 与迁移前一致的错误文案（在任何落盘之前）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['PUT', `${P}/tasks`, '缺少任务 id'],
      ['DELETE', `${P}/tasks`, '缺少任务 id'],
      ['POST', `${P}/tasks/toggle`, '缺少任务 id'],
      ['POST', `${P}/tasks/run`, '缺少任务 id'],
      ['DELETE', `${P}/history`, '缺少执行记录 id'],
    ]
    for (const [method, path, error] of cases) {
      const response = await sendJson(base, method, path, '{}')
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error })
    }

    // id 类型不符（数字）同样按缺省处理，不被当作合法 id 放行。
    const wrongType = await sendJson(base, 'DELETE', `${P}/tasks`, JSON.stringify({ id: 42 }))
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toEqual({ error: '缺少任务 id' })

    dispose()
  })

  it('非法请求体在 create 路由返回 400（校验先于落盘）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const empty = await sendJson(base, 'POST', `${P}/tasks`, JSON.stringify({}))
    expect(empty.status).toBe(400)

    const invalidJson = await sendJson(base, 'POST', `${P}/tasks`, 'not-json')
    expect(invalidJson.status).toBe(400)

    dispose()
  })
})
