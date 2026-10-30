/**
 * 批次 03 · `dsh-tauri-rightclick` 的宿主路由（契约见 `docs/specs/plugin.test.md`）。
 *
 * 本插件是唯一带真实系统副作用的 L2 路由：`open/url` 与 `open/path` 的正向分支会真的
 * 拉起本机浏览器 / 文件管理器。因此这里只落地**在副作用之前就返回**的拒绝分支；
 * 正向用例（合法外链 200）会打开用户桌面，改为手工执行并在文档中标注。
 *
 * 断言对象是外部世界（HTTP 状态码与响应字节），不采信插件自报。
 * 宿主复用 globalSetup 的共享实例（已挂载 dsh-tauri-rightclick），不另起进程。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'

const OPEN_URL_PATH = '/api/tauri/rightclick/open/url'
const OPEN_PATH_PATH = '/api/tauri/rightclick/open/path'

interface OperationResult {
  ok?: boolean
  error?: string
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

/** 发一条 JSON POST（默认 `application/json` 内容类型）。 */
function postJson(path: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: apiHeaders({ 'content-type': contentType }),
    body: JSON.stringify(body),
  })
}

describe('宿主路由：open/url', () => {
  it('[反向] 验证非 JSON 请求体被 415 拒绝', async () => {
    const response = await fetch(url(OPEN_URL_PATH), {
      method: 'POST',
      headers: apiHeaders({ 'content-type': 'text/plain' }),
      body: 'url=https://example.com',
    })

    expect(response.status, '非 JSON 内容类型必须在读体与打开之前被拒').toBe(415)
    expect(
      await response.json() as OperationResult,
      '拒绝理由必须是内容类型，而不是 URL 校验',
    ).toEqual({ ok: false, error: 'unsupported-media-type' })
  })

  it('[反向] 验证危险 scheme 被 open/url 拒绝', async () => {
    const payloads: unknown[] = ['javascript:alert(1)', 'file:///etc/passwd', '', 123]

    for (const payload of payloads) {
      const response = await postJson(OPEN_URL_PATH, { url: payload })

      expect(response.status, `url=${JSON.stringify(payload)} 必须被 400 拒绝`).toBe(400)
      expect(
        await response.json() as OperationResult,
        `url=${JSON.stringify(payload)} 只放行 http/https`,
      ).toEqual({ ok: false, error: 'invalid-url' })
    }
  })
})

describe('宿主路由：open/path', () => {
  it('[反向] 验证空路径与带 scheme 的值被 open/path 拒绝', async () => {
    const payloads = ['', '   ', 'https://example.com']

    for (const payload of payloads) {
      const response = await postJson(OPEN_PATH_PATH, { path: payload })

      expect(response.status, `path=${JSON.stringify(payload)} 必须被 400 拒绝`).toBe(400)
      expect(
        await response.json() as OperationResult,
        `path=${JSON.stringify(payload)} 不是本地路径`,
      ).toEqual({ ok: false, error: 'invalid-path' })
    }
  })

  it('[反向] 验证不存在的目录返回 not-a-directory 且不产生副作用', async () => {
    const missing = join(inject('dshHome'), 'definitely-missing-dir')
    expect(existsSync(missing), '夹具必须落在 scratch DSH_HOME 下的不存在路径').toBe(false)

    const response = await postJson(OPEN_PATH_PATH, { path: missing })

    expect(response.status, '目录不存在必须在 stat 阶段就被拒，而不是交给 explorer').toBe(400)
    expect(
      await response.json() as OperationResult,
      '失败理由必须点明不是目录，而不是路径格式非法',
    ).toEqual({ ok: false, error: 'not-a-directory' })
  })

  it('[反向] 验证 open/path 的非 JSON 请求体被 415 拒绝', async () => {
    const response = await fetch(url(OPEN_PATH_PATH), {
      method: 'POST',
      headers: apiHeaders({ 'content-type': 'text/plain' }),
      body: 'path=/definitely-not-a-real-dir',
    })

    expect(response.status, '非 JSON 内容类型必须在读体与打开之前被拒').toBe(415)
    expect(
      await response.json() as OperationResult,
      '拒绝理由必须来自 path 处理器自己的守卫，而不是路径校验',
    ).toEqual({ ok: false, error: 'unsupported-media-type' })
  })
})
