import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Binding } from '../types'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '.'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { resetRuntime } from '../config/runtime'
import { ledger } from '../service/ledger'

const P = '/api/tauri/worktree'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_PATHS: readonly string[] = [
  P,
  `${P}/bindings`,
  `${P}/status`,
  `${P}/checkouts`,
]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [P]: 'POST, DELETE',
  [`${P}/bindings`]: 'GET, HEAD, POST',
  [`${P}/status`]: 'GET, HEAD',
  [`${P}/checkouts`]: 'POST',
}

const UNDECLARED_METHOD = 'PUT'

interface Harness {
  registered: Map<string, HostRoute>
  ctx: RoutesContext
}

let sessionHost: Record<string, unknown> = {}

function createHarness(): Harness {
  const registered = new Map<string, HostRoute>()
  return {
    registered,
    ctx: {
      webServer: {
        register(route: HostRoute): () => void {
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
      ...sessionHost,
    } as unknown as RoutesContext,
  }
}

const servers: Server[] = []
const temporaryDirectories: string[] = []

beforeEach(() => {
  sessionHost = {}
  resetTestDshHome()
  resetRuntime()
})

afterEach(async () => {
  resetRuntime()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(registered: Map<string, HostRoute>): Promise<string> {
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

function sendJson(base: string, path: string, method: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function createBinding(sessionId: string, worktreePath: string): Binding {
  return {
    sessionId,
    sourceSessionId: 'source-a',
    hash: 'hash-a',
    dirname: 'repo',
    worktreePath,
    projectPath: '/tmp/repo',
    branchName: 'dsh/x',
    ownsBranch: true,
    createdAt: new Date().toISOString(),
    log: ['created'],
  }
}

describe('工作树路由声明', () => {
  it('声明 4 条 exact 路径共 6 条路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(harness.registered.size).toBe(EXPECTED_PATHS.length)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法返回 405 + allow 头', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    for (const path of EXPECTED_PATHS) {
      const response = await fetch(`${base}${path}`, { method: UNDECLARED_METHOD })
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort(), path).toEqual(ALLOW_BY_PATH[path].split(', ').sort())
    }

    dispose()
  })

  it('未声明的 OPTIONS 返回原生 405 与实际方法集合', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const collection = await fetch(`${base}${P}`, { method: 'OPTIONS' })
    expect(collection.status).toBe(405)
    expect(collection.headers.get('allow')?.split(', ').sort()).toEqual(['DELETE', 'POST'])

    const status = await fetch(`${base}${P}/status`, { method: 'OPTIONS' })
    expect(status.status).toBe(405)
    expect(status.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'HEAD'])

    dispose()
  })

  it('缺 sessionId 的写路由返回 400', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    for (const path of [P, `${P}/bindings`]) {
      const response = await sendJson(base, path, 'POST', '{}')
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error: '缺少 sessionId' })
    }

    dispose()
  })
})

describe('工作树路由真实创建链路', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  function createRepository(): string {
    const repository = mkdtempSync(join(tmpdir(), 'dsh-routes-repo-'))
    temporaryDirectories.push(repository)
    git(repository, 'init', '-b', 'main')
    git(repository, 'config', 'user.email', 'test@example.com')
    git(repository, 'config', 'user.name', 'Test')
    git(repository, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repository, 'README.md'), '# repo\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'init')
    return repository
  }

  function bindSession(sessionId: string, cwd: string): void {
    sessionHost = {
      sessions: { get: (id: string) => (id === sessionId ? { header: { cwd } } : undefined) },
    }
  }

  function worktreeRegistrations(repository: string): number {
    return git(repository, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .length
  }

  async function postCreate(base: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
    const response = await sendJson(base, P, 'POST', JSON.stringify(body))
    return { status: response.status, body: await response.json() }
  }

  it('pOST 集合根在真实 git 仓库上创建工作树并落盘绑定', async () => {
    const repository = createRepository()
    const sessionId = 'session-create'
    bindSession(sessionId, repository)

    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const { status, body } = await postCreate(base, { sessionId, sourceSessionId: sessionId })
    const hash = createHash('sha256').update(`${repository}:${sessionId}`).digest('hex').slice(0, 12)
    const expected = join(testDshHome, 'worktrees', hash, basename(repository))

    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      hash,
      dirname: basename(repository),
      worktreeKey: `${hash}/${basename(repository)}`,
      worktreePath: expected,
      projectPath: repository,
      sourceSessionId: sessionId,
      existed: false,
      inherited: false,
    })
    expect(git(expected, 'rev-parse', 'HEAD')).toBe(git(repository, 'rev-parse', 'refs/heads/main'))
    expect(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(readFileSync(join(expected, 'README.md'), 'utf8')).toBe('# repo\n')
    expect(git(repository, 'branch', '--list', 'dsh/*')).toBe('')
    expect(worktreeRegistrations(repository)).toBe(2)
    expect(ledger.load(sessionId)?.worktreePath).toBe(expected)

    const listed = await (await fetch(`${base}${P}/bindings`)).json() as { bindings: Array<{ sessionId: string, worktreeKey: string }> }
    expect(listed.bindings.map(binding => binding.sessionId)).toEqual([sessionId])
    expect(listed.bindings[0].worktreeKey).toBe(`${hash}/${basename(repository)}`)

    dispose()
  })

  it('pOST 集合根重复创建时幂等返回 existed 且不重复注册', async () => {
    const repository = createRepository()
    const sessionId = 'session-idempotent'
    bindSession(sessionId, repository)

    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const first = await postCreate(base, { sessionId, sourceSessionId: sessionId })
    const second = await postCreate(base, { sessionId, sourceSessionId: sessionId })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.existed).toBe(false)
    expect(second.body.existed).toBe(true)
    expect(second.body.worktreePath).toBe(first.body.worktreePath)
    expect(worktreeRegistrations(repository)).toBe(2)
    expect(ledger.load(sessionId)?.worktreePath).toBe(first.body.worktreePath)

    dispose()
  })

  it('pOST 集合根解析不出会话目录时返回 400 且不落盘绑定', async () => {
    const repository = createRepository()

    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const { status, body } = await postCreate(base, { sessionId: 'session-orphan', sourceSessionId: 'session-orphan' })

    expect(status).toBe(400)
    expect(body).toEqual({ error: '无法解析会话工作目录：会话尚未就绪，请稍后重试' })
    expect(ledger.load('session-orphan')).toBeNull()
    expect(existsSync(join(testDshHome, 'worktrees'))).toBe(false)
    expect(worktreeRegistrations(repository)).toBe(1)

    dispose()
  })
})

describe('工作树路由响应', () => {
  it('账本为空时 /bindings 返回空列表', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/bindings`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bindings: [], jobs: [] })

    dispose()
  })

  it('/bindings 只列出工作树目录仍存在的绑定', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
    temporaryDirectories.push(directory)
    const live = join(directory, 'live')
    mkdirSync(live, { recursive: true })
    await ledger.save('session-live', createBinding('session-live', live))
    await ledger.save('session-gone', createBinding('session-gone', join(directory, 'gone')))

    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const body = await (await fetch(`${base}${P}/bindings`)).json() as {
      bindings: Array<{ sessionId: string, worktreeKey: string }>
    }
    expect(body.bindings.map(binding => binding.sessionId)).toEqual(['session-live'])
    expect(body.bindings[0].worktreeKey).toBe('hash-a/repo')

    dispose()
  })

  it('无绑定时 /status 返回本地工作区事实', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/status?sessionId=session-none`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'local', projectPath: '', isGit: null })

    dispose()
  })

  it('dELETE 集合根对已消失的确定性路径幂等成功', async () => {
    const harness = createHarness()
    const dispose = server(harness.ctx)
    const base = await listen(harness.registered)

    const response = await sendJson(base, P, 'DELETE', JSON.stringify({
      sessionId: 'session-none',
      worktreeHashDirname: 'hash-none/repo',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    dispose()
  })
})
