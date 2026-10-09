import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LiveSnapshot } from '../types'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '.'
import { resetTestDshHome } from '../../../../.test/test-utils'
import { disposeRuntime } from '../config/runtime'
import { capture } from '../service/capture'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

vi.mock('../service/capture', () => ({ capture: { live: vi.fn() } }))
vi.mock('../service/ledger', () => ({
  ledger: {
    load: async () => ({
      version: 1,
      sessionId: 'session',
      workspaceRoot: null,
      isGit: false,
      unavailableReason: null,
      turns: [],
    }),
  },
}))
vi.mock('../service/workspace', () => ({
  workspace: {
    peek: () => true,
    resolve: async () => ({ ok: true, root: 'C:/repo', commonDir: 'C:/repo/.git' }),
  },
}))

const P = '/api/tauri/experimental'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const SUMMARY_PATH = `${P}/summary`
const LIVE_PATH = `${P}/live`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', SUMMARY_PATH],
  ['GET', LIVE_PATH],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [SUMMARY_PATH]: 'GET, HEAD',
  [LIVE_PATH]: 'GET, HEAD',
}

const UNDECLARED_METHOD = 'PUT'

const liveReadings = new Map<string, LiveSnapshot>()

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

function mount(harness: Harness): () => void {
  const dispose = server(harness.ctx)
  disposers.push(dispose)
  return dispose
}

beforeEach(() => {
  resetTestDshHome()
  disposeRuntime()
  liveReadings.clear()
  vi.mocked(capture.live).mockImplementation(sessionId =>
    liveReadings.get(sessionId) ?? { active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 })
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  disposeRuntime()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('running-changes 路由声明', () => {
  it('声明 2 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(EXPECTED_ROUTES).toHaveLength(2)
    expect(harness.registered.size).toBe(2)

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

    const summary = await fetch(`${base}${SUMMARY_PATH}`, { method: 'OPTIONS' })
    expect(summary.status).toBe(405)
    expect(summary.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD'.split(', ').sort())

    const live = await fetch(`${base}${LIVE_PATH}`, { method: 'OPTIONS' })
    expect(live.status).toBe(405)
    expect(live.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD'.split(', ').sort())

    dispose()
  })

  it('缺 sessionId 的读路由返回 400（在任何落盘之前）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const summary = await fetch(`${base}${SUMMARY_PATH}`)
    expect(summary.status).toBe(400)
    expect(await summary.json()).toEqual({ error: '缺少 sessionId' })

    const live = await fetch(`${base}${LIVE_PATH}`)
    expect(live.status).toBe(400)
    expect(await live.json()).toEqual({ error: '缺少 sessionId' })

    dispose()
  })

  it('live 读数面原样回传 capture 服务给出的替身读数', async () => {
    liveReadings.set('abc', { active: true, turn: 7, fileCount: 3, insertions: 0, deletions: 0 })
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${LIVE_PATH}?sessionId=abc`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active: true,
      turn: 7,
      fileCount: 3,
      insertions: 0,
      deletions: 0,
    })

    dispose()
  })

  it('同一 routes 声明在两次注册下注册表各自独立、卸载互不影响', async () => {
    liveReadings.set('ab', { active: true, turn: 11, fileCount: 2, insertions: 0, deletions: 0 })
    liveReadings.set('abcd', { active: true, turn: 22, fileCount: 4, insertions: 0, deletions: 0 })
    const first = createHarness()
    const second = createHarness()
    const disposeFirst = mount(first)
    const disposeSecond = mount(second)
    const firstBase = await listen(first.registered)
    const secondBase = await listen(second.registered)

    const firstBody = await (await fetch(`${firstBase}${LIVE_PATH}?sessionId=ab`)).json()
    const secondBody = await (await fetch(`${secondBase}${LIVE_PATH}?sessionId=abcd`)).json()

    // 注册表各自独立，两次注册的处理器都只读自己那次注册的宿主 ctx。
    expect(firstBody).toMatchObject({ turn: 11, fileCount: 2 })
    expect(secondBody).toMatchObject({ turn: 22, fileCount: 4 })

    // 卸载其中一次不影响另一次。
    disposeFirst()
    expect(first.registered.size).toBe(0)
    expect(second.registered.size).toBe(2)
    expect(await (await fetch(`${secondBase}${LIVE_PATH}?sessionId=abcd`)).json()).toMatchObject({ turn: 22 })

    disposeSecond()
  })
})
