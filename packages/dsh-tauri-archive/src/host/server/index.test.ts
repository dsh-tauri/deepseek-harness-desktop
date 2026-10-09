import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '.'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { archive } from '../service/archive'
import { session } from '../service/session'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const P = '/api/tauri/archive'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/session/archive`],
  ['POST', `${P}/session/archive`],
  ['DELETE', `${P}/session/archive`],
  ['POST', `${P}/session/archive/clear`],
  ['DELETE', `${P}/session/archive/clear`],
  ['POST', `${P}/session/workspace/archive`],
  ['DELETE', `${P}/session/workspace/archive`],
  ['POST', `${P}/session/archive/restore`],
  ['POST', `${P}/session/open/path`],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [`${P}/session/archive`]: 'GET, HEAD, POST, DELETE',
  [`${P}/session/archive/clear`]: 'POST, DELETE',
  [`${P}/session/workspace/archive`]: 'POST, DELETE',
  [`${P}/session/archive/restore`]: 'POST',
  [`${P}/session/open/path`]: 'POST',
}

const UNDECLARED_METHOD = 'PUT'

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
      sessions: {
        get: (id: string) => (id === 'archived-1'
          ? { id, header: { createdAt: 1_700_000_000_000, cwd: 'C:/project' } }
          : undefined),
      },
      workspaceRegistry: { archivedSessionIds: ['archived-1'] },
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

function postJson(base: string, path: string, method: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

beforeEach(() => {
  resetTestDshHome()
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  resetTestDshHome()
  vi.restoreAllMocks()
})

describe('归档路由声明', () => {
  it.each([
    ['POST', '/session/archive', 'single'],
    ['DELETE', '/session/archive', 'single'],
    ['POST', '/session/archive/restore', 'single'],
    ['POST', '/session/open/path', 'single'],
    ['POST', '/session/workspace/archive', 'many'],
    ['DELETE', '/session/workspace/archive', 'many'],
  ] as const)('%s %s preserves invalid body status and error without calling services', async (method, path, kind) => {
    const calls = [
      vi.spyOn(archive, 'archive'),
      vi.spyOn(archive, 'delete'),
      vi.spyOn(archive, 'unarchive'),
      vi.spyOn(archive, 'archiveWorkspace'),
      vi.spyOn(archive, 'deleteSelected'),
      vi.spyOn(session, 'openDir'),
    ]
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)
    const invalid = kind === 'single'
      ? [{}, { sessionId: '' }, { sessionId: 1 }, { sessionId: [] }, { sessionId: null }, null, [], 'id']
      : [{}, { sessionIds: [] }, { sessionIds: [''] }, { sessionIds: 'id' }, { sessionIds: null }, null, [], 'id']
    for (const body of invalid) {
      const response = await postJson(base, `${P}${path}`, method, JSON.stringify(body))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: kind === 'single' ? 'invalid-session-id' : 'invalid-session-ids' })
    }
    for (const call of calls)
      expect(call).not.toHaveBeenCalled()
    dispose()
  })

  it('single routes accept whitespace without trimming and delegate to their public service methods', async () => {
    const calls = [
      vi.spyOn(archive, 'archive').mockResolvedValue({ archivedSessionIds: [' '], meta: {} }),
      vi.spyOn(archive, 'delete').mockResolvedValue({ ok: true }),
      vi.spyOn(archive, 'unarchive').mockResolvedValue({ ok: true }),
      vi.spyOn(session, 'openDir').mockResolvedValue({ ok: true }),
    ]
    const paths = [['POST', '/session/archive'], ['DELETE', '/session/archive'], ['POST', '/session/archive/restore'], ['POST', '/session/open/path']]
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)
    for (const [method, path] of paths) {
      const response = await postJson(base, `${P}${path}`, method!, JSON.stringify({ sessionId: ' ' }))
      expect(response.status).toBe(200)
    }
    for (const call of calls) {
      expect(call).toHaveBeenCalledExactlyOnceWith(' ')
    }
    dispose()
  })

  it.each(['POST', 'DELETE'])('workspace %s preserves String conversion, duplicates, order and optional workspaceId', async (method) => {
    const call = method === 'POST'
      ? vi.spyOn(archive, 'archiveWorkspace').mockResolvedValue({ archivedSessionIds: [], meta: {} })
      : vi.spyOn(archive, 'deleteSelected').mockResolvedValue({ ok: true })
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)
    const response = await postJson(base, `${P}/session/workspace/archive`, method, JSON.stringify({
      workspaceId: 'workspace',
      sessionIds: ['', 'id', 'id', 0, false, null, {}, ' '],
    }))
    expect(response.status).toBe(200)
    expect(call).toHaveBeenCalledExactlyOnceWith(['id', 'id', '0', 'false', 'null', '[object Object]', ' '])
    dispose()
  })

  it('按 RESTful 资源树声明 exact 路由，同路径多方法收敛为一行，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    // 9 条 (方法, 路径) 声明收敛为 5 条宿主注册行。
    expect(EXPECTED_ROUTES).toHaveLength(9)
    expect(harness.registered.size).toBe(5)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('gET /session/archive 返回宿主归档集合与每个会话的元数据', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/session/archive`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      archivedSessionIds: ['archived-1'],
      meta: { 'archived-1': { createdAt: 1_700_000_000_000, cwd: 'C:/project' } },
    })

    dispose()
  })

  it('未声明的方法返回 405 + allow 头（每条路径的方法集与声明一致）', async () => {
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

  it('已声明的 (方法, 路径) 都能进到处理器（不被 405 挡下）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [method, path] of EXPECTED_ROUTES) {
      // GET/HEAD 按 fetch 规范不能带请求体，其余方法统一带一个 JSON 空对象。
      const response = method === 'GET' || method === 'HEAD'
        ? await fetch(`${base}${path}`, { method })
        : await postJson(base, path, method, '{}')
      expect(response.status, `${method} ${path}`).not.toBe(405)
    }

    dispose()
  })

  it('oPTIONS 未声明时返回 405 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const archive = await fetch(`${base}${P}/session/archive`, { method: 'OPTIONS' })
    expect(archive.status).toBe(405)
    expect(archive.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD, POST, DELETE'.split(', ').sort())

    const clear = await fetch(`${base}${P}/session/archive/clear`, { method: 'OPTIONS' })
    expect(clear.status).toBe(405)
    expect(clear.headers.get('allow')?.split(', ').sort()).toEqual('POST, DELETE'.split(', ').sort())

    dispose()
  })

  it('/session/archive/clear 的 POST 与 DELETE 都登记到同一处理器', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    // 两种方法都必须被路由（不是 405），且落到同一个处理器 → 同一状态码。
    const post = await fetch(`${base}${P}/session/archive/clear`, { method: 'POST' })
    const del = await fetch(`${base}${P}/session/archive/clear`, { method: 'DELETE' })
    expect(post.status).not.toBe(405)
    expect(del.status).not.toBe(405)
    expect(del.status).toBe(post.status)

    dispose()
  })

  it('dELETE 路由的请求体仍按 JSON 解析并走领域校验', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    // 空对象 → 处理器体内的 sessionId 校验（在触碰领域服务之前）给出 400 领域错误。
    const missingId = await postJson(base, `${P}/session/archive`, 'DELETE', '{}')
    expect(missingId.status).toBe(400)
    expect(await missingId.json()).toEqual({ ok: false, error: 'invalid-session-id' })

    const missingIds = await postJson(base, `${P}/session/workspace/archive`, 'DELETE', '{}')
    expect(missingIds.status).toBe(400)
    expect(await missingIds.json()).toEqual({ ok: false, error: 'invalid-session-ids' })

    // 非法 JSON 体同样在读体阶段结束为 400。
    const invalidJson = await postJson(base, `${P}/session/archive`, 'DELETE', 'not-json')
    expect(invalidJson.status).toBe(400)

    dispose()
  })

  it('pOST /session/open/path 缺少 sessionId 或目录不存在时返回 400 领域错误', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const missing = await postJson(base, `${P}/session/open/path`, 'POST', '{}')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ ok: false, error: 'invalid-session-id' })

    const unknown = await postJson(
      base,
      `${P}/session/open/path`,
      'POST',
      JSON.stringify({ sessionId: '__missing_session__' }),
    )
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ ok: false, error: 'session-directory-not-found' })

    dispose()
  })

  it('已定位到的会话目录经 DSH_HOME 替身解析后交给 openDirectory，不触碰真实 ~/.dsh', async () => {
    const dir = join(testDshHome, 'sessions', '--project-a--', 'session-abc')
    mkdirSync(dir, { recursive: true })
    const dshTauri = await import('dsh-tauri')
    const opened = vi.spyOn(dshTauri, 'openDirectory').mockResolvedValue(undefined)

    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await postJson(
      base,
      `${P}/session/open/path`,
      'POST',
      JSON.stringify({ sessionId: 'abc' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith(dir)
    expect(dshTauri.DSH_HOME).toBe(testDshHome)

    dispose()
  })

  it('非对象 / 非法 JSON / 非 JSON 编码体返回 400', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const arrayBody = await postJson(base, `${P}/session/open/path`, 'POST', '[]')
    expect(arrayBody.status).toBe(400)

    const invalidJson = await postJson(base, `${P}/session/open/path`, 'POST', 'not-json')
    expect(invalidJson.status).toBe(400)

    // 请求体一律按 JSON 解析：urlencoded 体不会被当成合法对象放行。
    const urlencoded = await fetch(`${base}${P}/session/open/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=archived-1',
    })
    expect(urlencoded.status).toBe(400)

    dispose()
  })
})
