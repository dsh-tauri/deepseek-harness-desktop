import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '.'
import { resetTestDshHome } from '../../../../.test/test-utils'
import { mcp } from '../service/mcp'
import { mcpAuth } from '../service/mcp-auth'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const P = '/api/tauri/extension'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/skills`],
  ['POST', `${P}/skills/refresh`],
  ['GET', `${P}/skill`],
  ['POST', `${P}/skill`],
  ['DELETE', `${P}/skill`],
  ['POST', `${P}/skill/policy`],
  ['POST', `${P}/open/dir`],
  ['GET', `${P}/mcp`],
  ['POST', `${P}/mcp`],
  ['DELETE', `${P}/mcp`],
  ['POST', `${P}/mcp/toggle`],
  ['POST', `${P}/mcp/check`],
  ['POST', `${P}/mcp/authorize`],
  ['GET', `${P}/mcp/authorize`],
  ['POST', `${P}/mcp/copy`],
  ['GET', `${P}/import/scan`],
  ['POST', `${P}/import/apply`],
  ['GET', `${P}/roots`],
  ['POST', `${P}/roots`],
  ['DELETE', `${P}/roots`],
  ['POST', `${P}/host/restart`],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

const ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function allowFor(path: string): string {
  const methods = new Set(EXPECTED_ROUTES.filter(([, candidate]) => candidate === path).map(([method]) => method))
  if (methods.has('GET'))
    methods.add('HEAD')
  return ALLOW_ORDER.filter(method => methods.has(method)).join(', ')
}

const UNDECLARED_METHOD = 'PATCH'

const SKILL = {
  name: 'demo-skill',
  description: 'A demo skill',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-dsh',
  provider: 'filesystem',
}

interface Harness {
  ctx: unknown
  registered: Map<string, WebRoute>
  dir: string
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tauri-extension-'))
  const registered = new Map<string, WebRoute>()
  return {
    dir,
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
      skills: {
        list: async () => [SKILL],
        get: async (name: string) => (name === SKILL.name
          ? { name, content: '# demo', path: join(dir, 'skills', name, 'SKILL.md') }
          : undefined),
      },
    } as unknown as Context,
  }
}

const disposers: Array<() => void> = []

function mount(harness: Harness, hotReload = false, reload: () => Promise<boolean> = async () => hotReload): () => void {
  const dispose = server(harness.ctx as Context, {
    profileDirPath: join(harness.dir, 'profiles', 'web'),
    remountProvider: async () => {},
    hotReload: () => hotReload,
    reload,
  })
  disposers.push(dispose)
  return dispose
}

const servers: Server[] = []
const dirs: string[] = []

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

async function start(): Promise<{ base: string, dispose: () => void }> {
  const harness = createHarness()
  dirs.push(harness.dir)
  const dispose = mount(harness)
  const base = await listen(harness.registered)
  return { base, dispose }
}

beforeEach(() => {
  resetTestDshHome()
})

afterEach(async () => {
  vi.restoreAllMocks()
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('能力管理器路由声明', () => {
  it('按资源化的路径与方法声明 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    dirs.push(harness.dir)
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(harness.registered.size).toBe(EXPECTED_PATHS.length)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法拒绝访问（405 + allow 头）', async () => {
    const { base, dispose } = await start()

    for (const path of EXPECTED_PATHS) {
      const response = await fetch(`${base}${path}`, { method: UNDECLARED_METHOD })
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort(), path).toEqual(allowFor(path).split(', ').sort())
    }

    dispose()
  })

  it('oPTIONS 未声明时返回 405 并带 allow 头', async () => {
    const { base, dispose } = await start()

    const read = await fetch(`${base}${P}/mcp`, { method: 'OPTIONS' })
    expect(read.status).toBe(405)
    expect(read.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD, POST, DELETE'.split(', ').sort())

    const mutate = await fetch(`${base}${P}/mcp/toggle`, { method: 'OPTIONS' })
    expect(mutate.status).toBe(405)
    expect(mutate.headers.get('allow')?.split(', ').sort()).toEqual('POST'.split(', ').sort())

    dispose()
  })

  it('gET /skills 返回宿主技能目录行（含编辑标志，不带 resourceBase 即不可编辑）', async () => {
    const { base, dispose } = await start()

    const response = await fetch(`${base}${P}/skills`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      skills: [{
        name: 'demo-skill',
        description: 'A demo skill',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-dsh',
        provider: 'filesystem',
        editable: false,
        removable: true,
        policyEditable: false,
      }],
    })

    dispose()
  })

  it('gET /skill 命中返回内容，未命中返回 404 领域错误', async () => {
    const { base, dispose } = await start()

    const found = await fetch(`${base}${P}/skill?name=demo-skill`)
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ name: 'demo-skill', content: '# demo' })

    const missing = await fetch(`${base}${P}/skill?name=nope`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'skill not found' })

    dispose()
  })

  it('gET /mcp 在空的 patch 层上返回空列表并带 restartNeeded', async () => {
    const { base, dispose } = await start()

    const response = await fetch(`${base}${P}/mcp`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ servers: [], restartNeeded: true })

    dispose()
  })

  it('授权与检测按作用域读取服务器，授权轮询不泄露令牌', async () => {
    const { base } = await start()
    const row = { id: 'figma', serverName: 'figma', transport: 'streamable-http' as const, disabled: false, url: 'https://mcp.example.test/mcp' }
    const peek = vi.spyOn(mcp, 'peek').mockReturnValue([row])
    vi.spyOn(mcp, 'check').mockResolvedValue({ ok: false, requiresAuth: true, detail: 'Unauthorized' })
    const startAuth = vi.spyOn(mcpAuth, 'start').mockResolvedValue({ authorizationUrl: 'https://auth.example.test/authorize', attemptId: 'attempt-1' })
    vi.spyOn(mcpAuth, 'lookup').mockReturnValue({ status: 'authorized' })
    const checked = await fetch(`${base}${P}/mcp/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id, scope: 'global' }) })
    expect(await checked.json()).toEqual({ ok: false, requiresAuth: true, detail: 'Unauthorized' })
    const dir = peek.mock.calls[0]?.[0]
    const authorized = await fetch(`${base}${P}/mcp/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id, scope: 'global' }) })
    expect(await authorized.json()).toEqual({ authorizationUrl: 'https://auth.example.test/authorize', attemptId: 'attempt-1' })
    expect(peek.mock.calls[1]?.[0]).toBe(dir)
    expect(startAuth).toHaveBeenCalledWith(row)
    const status = await fetch(`${base}${P}/mcp/authorize?attemptId=attempt-1`)
    expect(await status.json()).toEqual({ status: 'authorized' })
    const missing = await fetch(`${base}${P}/mcp/authorize`)
    expect(missing.status).toBe(400)
  })

  it('授权启动的已知协议错误返回 422 且保留安全诊断', async () => {
    const { base } = await start()
    vi.spyOn(mcp, 'peek').mockReturnValue([{ id: 'figma', serverName: 'figma', transport: 'streamable-http', disabled: false, url: 'https://mcp.example.test/mcp' }])
    const message = 'MCP OAuth client registration failed (HTTP 403). The server may require an approved MCP client.'
    vi.spyOn(mcpAuth, 'start').mockRejectedValue(Object.assign(new Error(message), { code: 'MCP_OAUTH_START_FAILED' }))
    const response = await fetch(`${base}${P}/mcp/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'figma' }) })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: message })
  })

  it('未知授权错误仍返回 500 且不泄露原始异常中的秘密', async () => {
    const { base } = await start()
    vi.spyOn(mcp, 'peek').mockReturnValue([{ id: 'figma', serverName: 'figma', transport: 'streamable-http', disabled: false, url: 'https://mcp.example.test/mcp' }])
    vi.spyOn(mcpAuth, 'start').mockRejectedValue(new Error('client_secret=secret-marker code_verifier=secret-marker access_token=secret-marker refresh_token=secret-marker https://auth.example.test/?code=secret-marker'))
    const response = await fetch(`${base}${P}/mcp/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'figma' }) })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'MCP OAuth authorization could not start' })
  })

  it('拒绝未知授权任务和不存在的 MCP，stdio 不进入 OAuth', async () => {
    const { base } = await start()
    const unknown = await fetch(`${base}${P}/mcp/authorize?attemptId=missing`)
    expect(unknown.status).toBe(404)
    const absent = await fetch(`${base}${P}/mcp/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'missing' }) })
    expect(absent.status).toBe(404)
    vi.spyOn(mcp, 'peek').mockReturnValue([{ id: 'local', serverName: 'local', transport: 'stdio', command: 'test-fixture', disabled: false }])
    const local = await fetch(`${base}${P}/mcp/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'local' }) })
    expect(local.status).toBe(400)
    expect(await local.json()).toEqual({ error: 'only HTTP MCP servers support authorization' })
  })

  it('hMR 在线时 mcp 列表不再要求重启', async () => {
    const harness = createHarness()
    dirs.push(harness.dir)
    const dispose = mount(harness, true)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/mcp`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ servers: [], restartNeeded: false })

    dispose()
  })

  it('写盘成功后触发 reload，restartNeeded 取决于 reload 结果', async () => {
    const harness = createHarness()
    dirs.push(harness.dir)
    const reload = vi.fn(async () => false)
    const dispose = mount(harness, true, reload)
    const base = await listen(harness.registered)
    const input = { serverName: 'probe', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', disabled: false }
    const headers = { 'content-type': 'application/json' }

    const saved = await (await fetch(`${base}${P}/mcp`, { method: 'POST', headers, body: JSON.stringify(input) })).json() as { id: string, restartNeeded: boolean }
    expect(reload).toHaveBeenCalledTimes(1)
    expect(saved.restartNeeded).toBe(true)

    reload.mockResolvedValue(true)
    const toggled = await (await fetch(`${base}${P}/mcp/toggle`, { method: 'POST', headers, body: JSON.stringify({ id: saved.id, disabled: true }) })).json()
    expect(toggled).toEqual({ ok: true, restartNeeded: false })
    const removed = await (await fetch(`${base}${P}/mcp`, { method: 'DELETE', headers, body: JSON.stringify({ id: saved.id }) })).json()
    expect(removed).toEqual({ ok: true, restartNeeded: false })
    expect(reload).toHaveBeenCalledTimes(3)

    dispose()
  })

  it('pOST 变更路由对缺失字段返回 400 领域错误', async () => {
    const { base, dispose } = await start()

    const cases: ReadonlyArray<readonly [string, string, Record<string, unknown>, string]> = [
      ['POST', `${P}/mcp/toggle`, {}, 'id and disabled are required'],
      ['DELETE', `${P}/mcp`, {}, 'id is required'],
      ['POST', `${P}/mcp/check`, {}, 'id is required'],
      ['POST', `${P}/mcp/authorize`, {}, 'id and valid scope are required'],
      ['POST', `${P}/mcp/authorize`, { id: 'x', scope: 'elsewhere' }, 'id and valid scope are required'],
      ['POST', `${P}/mcp/copy`, {}, 'id is required'],
      ['DELETE', `${P}/roots`, {}, 'id is required'],
      ['POST', `${P}/roots`, { kind: 'zip' }, 'kind must be local or git'],
      ['POST', `${P}/open/dir`, {}, 'target is required'],
    ]
    for (const [method, path, body, error] of cases) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error })
    }

    dispose()
  })

  it('非对象 / 非法 JSON / 非 JSON 编码体在变更路由上返回 400', async () => {
    const { base, dispose } = await start()

    const invalidJson = await fetch(`${base}${P}/mcp/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(invalidJson.status).toBe(400)

    const urlencoded = await fetch(`${base}${P}/mcp/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=x&disabled=true',
    })
    expect(urlencoded.status).toBe(400)

    dispose()
  })

  it('pOST /host/restart 拒绝无 Origin 或带转发痕迹的请求（403，不触达进程控制）', async () => {
    const { base, dispose } = await start()

    const noOrigin = await fetch(`${base}${P}/host/restart`, { method: 'POST' })
    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.json()).toEqual({ error: 'untrusted origin' })

    const forwarded = await fetch(`${base}${P}/host/restart`, {
      method: 'POST',
      headers: { 'origin': base, 'x-forwarded-for': '127.0.0.1' },
    })
    expect(forwarded.status).toBe(403)
    expect(await forwarded.json()).toEqual({ error: 'untrusted origin' })

    dispose()
  })

  it('同一份声明两次注册下各读各的 deps（两次注册互不串台）', async () => {
    const first = createHarness()
    const second = createHarness()
    dirs.push(first.dir, second.dir)
    const disposeFirst = mount(first)
    const disposeSecond = mount(second)
    mkdirSync(join(first.dir, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(second.dir, 'profiles', 'web'), { recursive: true })
    const firstBase = await listen(first.registered)
    const secondBase = await listen(second.registered)

    const saved = await fetch(`${firstBase}${P}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'only-first', transport: 'http', url: 'http://127.0.0.1:9/mcp' }),
    })
    expect(saved.status).toBe(200)

    const firstRows = await (await fetch(`${firstBase}${P}/mcp`)).json() as { servers: unknown[] }
    expect(firstRows.servers).toHaveLength(1)

    const secondRows = await (await fetch(`${secondBase}${P}/mcp`)).json() as { servers: unknown[] }
    expect(secondRows.servers).toEqual([])

    disposeFirst()
    disposeSecond()
  })
})
