/**
 * 批次 05 · `dsh-tauri-worktree` 宿主路由（契约见 `docs/specs/plugin.test.md`）。
 *
 * 断言对象是外部世界（状态码、响应字节、清单回读），不采信插件自报。
 * 本文件刻意只覆盖**无需真实 git 仓库**的路径：`linkDependencies` 默认 `true`
 * （`packages/dsh-tauri-worktree/src/host/service/worktree.ts:47`），真实创建会改写本仓库
 * 的依赖目录，故所有用例的入参都在「缺参 / 未绑定」这一侧提前返回。
 *
 * 复用 globalSetup 的共享宿主（`also` 默认已挂载本插件），不另起进程。
 */

import { describe, expect, inject, it } from 'vitest'

/** 与 `packages/dsh-tauri-worktree/src/host/server/index.ts:12-17` 的注册行对齐。 */
const ROOT_PATH = '/api/tauri/worktree'
const BINDINGS_PATH = `${ROOT_PATH}/bindings`
const STATUS_PATH = `${ROOT_PATH}/status`
const CHECKOUTS_PATH = `${ROOT_PATH}/checkouts`

interface BindingsPayload {
  bindings: unknown[]
  jobs: unknown[]
}

interface ErrorPayload {
  ok?: boolean
  error?: string
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

/** 回读绑定清单：任何「不得产生副作用」的断言都以它为外部证据。 */
async function readBindings(): Promise<BindingsPayload> {
  const response = await fetch(url(BINDINGS_PATH), { headers: headers() })
  expect(response.status, '校验副作用前必须能读到绑定清单').toBe(200)
  return await response.json() as BindingsPayload
}

async function expectNoBinding(): Promise<void> {
  const payload = await readBindings()
  expect(payload.bindings, '拒绝的请求不得写入任何绑定').toEqual([])
  expect(payload.jobs, '拒绝的请求不得留下任何清理任务').toEqual([])
}

describe('L2 宿主路由', () => {
  it('验证干净环境下绑定清单为空且结构完整', async () => {
    const response = await fetch(url(BINDINGS_PATH), { headers: headers() })

    expect(response.status, '绑定清单路由必须存在且返回 200').toBe(200)

    const body = await response.json() as BindingsPayload
    expect(Object.keys(body).sort(), '线上载荷必须恰好是这两个字段').toEqual(['bindings', 'jobs'])
    expect(Array.isArray(body.bindings), 'bindings 必须是数组').toBe(true)
    expect(Array.isArray(body.jobs), 'jobs 必须是数组').toBe(true)
    expect(body.bindings, '全新 scratch 里绑定集合必须为空').toEqual([])
    expect(body.jobs, '全新 scratch 里清理队列必须为空').toEqual([])
  })

  it('[反向] 验证无绑定的会话状态回落到 local', async () => {
    const response = await fetch(`${url(STATUS_PATH)}?sessionId=not-bound`, { headers: headers() })

    expect(response.status, '无绑定的会话不得落到 missing 的 404 分支').toBe(200)

    const body = await response.json() as { mode?: string }
    expect(body.mode, '无绑定必须回落到 local').toBe('local')
  })

  it('[反向] 验证绑定创建缺 sessionId 返回 400', async () => {
    const response = await fetch(url(BINDINGS_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })

    expect(response.status, '缺 sessionId 必须 400').toBe(400)
    expect(await response.json() as ErrorPayload, '缺参文案必须逐字相等').toEqual({ error: '缺少 sessionId' })

    await expectNoBinding()
  })

  it('[反向] 验证创建请求缺 sessionId 返回 400', async () => {
    const response = await fetch(url(ROOT_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })

    expect(response.status, '缺 sessionId 必须在触碰 git 之前 400').toBe(400)

    const body = await response.json() as ErrorPayload
    expect(body.error, '缺参文案必须逐字相等').toBe('缺少 sessionId')
    expect(Object.hasOwn(body, 'worktreePath'), '失败响应不得带成功载荷字段').toBe(false)
    expect(JSON.stringify(body), '响应体不得出现任何工作树路径').not.toContain('worktreePath')

    await expectNoBinding()
  })

  it('验证删除请求缺参不报 4xx 而是幂等失败体', async () => {
    const first = await fetch(url(ROOT_PATH), {
      method: 'DELETE',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })

    expect(first.status, '该路由不校验 sessionId，缺参不得报 4xx').toBe(200)

    const body = await first.json() as ErrorPayload
    expect(body, '缺参必须返回幂等失败体').toEqual({ ok: false, error: '未找到绑定的工作树' })

    const second = await fetch(url(ROOT_PATH), {
      method: 'DELETE',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })
    expect(second.status, '重复删除必须仍为 200').toBe(200)
    expect(await second.json() as ErrorPayload, '重复删除必须返回同一失败体').toEqual(body)

    await expectNoBinding()
  })

  it('[反向] 验证切换分支缺绑定返回 400', async () => {
    const response = await fetch(url(CHECKOUTS_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionId: 'not-bound', branch: 'main' }),
    })

    expect(response.status, '未绑定的会话必须 400，而不是 500').toBe(400)
    expect(await response.json() as ErrorPayload, '领域错误必须先于任何 git 命令返回')
      .toEqual({ error: '未找到绑定的工作树' })

    await expectNoBinding()
  })

  it('[反向] 验证未知 jobId 的状态查询回落到 local', async () => {
    for (const query of ['jobId=', 'jobId=missing']) {
      const response = await fetch(`${url(STATUS_PATH)}?${query}`, { headers: headers() })

      expect(response.status, `${query} 的未知任务不得落到 missing 的 404 分支`).toBe(200)
      expect(
        await response.json() as { mode?: string, projectPath?: string, isGit?: boolean | null },
        `${query} 的未知任务实测按本地未绑定会话回读`,
      ).toEqual({ mode: 'local', projectPath: '', isGit: null })
    }

    await expectNoBinding()
  })
})
