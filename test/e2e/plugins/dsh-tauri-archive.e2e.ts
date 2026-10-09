/**
 * 批次 04 · `dsh-tauri-archive` 宿主路由（契约见 `docs/specs/plugin.test.md`）。
 *
 * 本批只走 HTTP，断言对象是外部世界（状态码、响应字节、`allow` 头），不采信插件自报。
 * `DELETE` 也按 JSON 读体是本插件与常规 REST 直觉相反的负向考点；`allow` 成员顺序属
 * 实现细节，一律按集合比较。
 *
 * 复用 globalSetup 的共享宿主（`also` 默认已挂载本插件），不另起进程。
 */

import { describe, expect, inject, it } from 'vitest'

/** 与 `packages/dsh-tauri-archive/src/host/server/index.ts` 的常量对齐。 */
const SESSION_ARCHIVE_PATH = '/api/tauri/archive/session/archive'
const SESSION_WORKSPACE_ARCHIVE_PATH = '/api/tauri/archive/session/workspace/archive'

const ARCHIVE_CLEAR_PATH = `${SESSION_ARCHIVE_PATH}/clear`
const ARCHIVE_RESTORE_PATH = `${SESSION_ARCHIVE_PATH}/restore`
const OPEN_PATH_PATH = '/api/tauri/archive/session/open/path'

interface ArchivedListPayload {
  archivedSessionIds: string[]
  meta: Record<string, unknown>
}

interface ErrorPayload {
  error?: string
  ok?: boolean
}

/** 宿主未处理异常的标准载荷（不是插件领域错误）。 */
interface UnhandledErrorPayload {
  status: number
  unhandled: boolean
  message: string
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' }

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

/** `allow` 成员顺序属实现细节，按集合比较。 */
function allowMethods(response: Response): string[] {
  return (response.headers.get('allow') ?? '').split(',').map(entry => entry.trim()).filter(Boolean).sort()
}

async function readArchive(): Promise<ArchivedListPayload> {
  const response = await fetch(url(SESSION_ARCHIVE_PATH), { headers: headers() })
  expect(response.status, '校验副作用前必须能读到归档清单').toBe(200)
  return await response.json() as ArchivedListPayload
}

/** 清空类请求：空归档集合上不得留下任何副作用，故每个用例收尾都回读一次。 */
async function expectArchiveEmpty(): Promise<void> {
  const payload = await readArchive()
  expect(payload.archivedSessionIds, '归档清单必须始终为空').toEqual([])
  expect(payload.meta, '空归档不得产出元数据').toEqual({})
}

describe('L2 宿主路由', () => {
  it('验证归档清单在干净环境返回空集合与固定形状', async () => {
    const response = await fetch(url(SESSION_ARCHIVE_PATH), { headers: headers() })

    expect(response.status, '归档清单路由必须存在且返回 200').toBe(200)

    const body = await response.json() as ArchivedListPayload
    expect(Object.keys(body).sort(), '线上载荷必须恰好是这两个字段（meta 不允许省略）')
      .toEqual(['archivedSessionIds', 'meta'])
    expect(body.archivedSessionIds, '全新 scratch 里归档集合必须为空').toEqual([])
    expect(body.meta, '空归档的 meta 必须是空对象').toEqual({})
  })

  it('[反向] 验证归档写入缺 sessionId 返回 400', async () => {
    const empty = await fetch(url(SESSION_ARCHIVE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })
    expect(empty.status, '缺 sessionId 必须 400').toBe(400)
    expect(await empty.json() as ErrorPayload, '缺参文案必须逐字相等').toEqual({ ok: false, error: 'invalid-session-id' })

    const nonString = await fetch(url(SESSION_ARCHIVE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionId: 123 }),
    })
    expect(nonString.status, '非字符串 sessionId 同样必须 400').toBe(400)
    expect(await nonString.json() as ErrorPayload, '非字符串不得被强转后放行').toEqual({ ok: false, error: 'invalid-session-id' })

    await expectArchiveEmpty()
  })

  it('[反向] 验证 DELETE 也按 JSON 读体，缺参同样 400', async () => {
    const response = await fetch(url(SESSION_ARCHIVE_PATH), { method: 'DELETE', headers: headers() })

    expect(response.status, '无 body 的 DELETE 必须 400（不是 204 也不是 405）').toBe(400)
    expect(await response.json() as ErrorPayload, 'DELETE 走同一条入参校验').toEqual({ ok: false, error: 'invalid-session-id' })
  })

  it('验证空归档集合下执行「清空」的当前行为', async () => {
    // 按现状固化：空归档集合上的清空落到宿主未处理异常（服务内部抛错），
    // 且抛出的领域文案不出现在响应体里——这正是本条要与「幂等返回 ok」区分的地方。
    const unhandledError: UnhandledErrorPayload = { status: 500, unhandled: true, message: 'HTTPError' }

    const posted = await fetch(url(ARCHIVE_CLEAR_PATH), { method: 'POST', headers: headers() })
    expect(posted.status, '空归档集合上的清空当前不是幂等成功').toBe(500)
    expect(await posted.json() as UnhandledErrorPayload, '响应体必须是宿主未处理异常的标准载荷').toEqual(unhandledError)

    const deleted = await fetch(url(ARCHIVE_CLEAR_PATH), { method: 'DELETE', headers: headers() })
    expect(deleted.status, 'POST 与 DELETE 共用同一处理器，行为必须一致').toBe(500)
    expect(await deleted.json() as UnhandledErrorPayload, '两个方法必须落到同一个未处理异常').toEqual(unhandledError)

    await expectArchiveEmpty()
  })

  it('[反向] 验证工作区批量归档缺 ids 返回 400', async () => {
    const missing = await fetch(url(SESSION_WORKSPACE_ARCHIVE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })
    expect(missing.status, '缺 sessionIds 字段必须 400').toBe(400)
    expect(await missing.json() as ErrorPayload, '缺字段文案必须逐字相等').toEqual({ ok: false, error: 'invalid-session-ids' })

    const emptyArray = await fetch(url(SESSION_WORKSPACE_ARCHIVE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionIds: [] }),
    })
    expect(emptyArray.status, '空数组与缺字段同判').toBe(400)
    expect(await emptyArray.json() as ErrorPayload, '空数组文案必须逐字相等').toEqual({ ok: false, error: 'invalid-session-ids' })
  })

  it('[反向] 验证打开不存在会话的目录返回领域错误', async () => {
    const response = await fetch(url(OPEN_PATH_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionId: 'does-not-exist' }),
    })

    expect(response.status, '目录缺失必须是 400，而不是 500（服务内部抛错）').toBe(400)
    expect(await response.json() as ErrorPayload, '领域错误必须先于系统打开动作返回').toEqual({ ok: false, error: 'session-directory-not-found' })
  })

  it('验证五条注册行的方法矩阵互不相同', async () => {
    const matrix: Array<[string, string[]]> = [
      [SESSION_ARCHIVE_PATH, ['DELETE', 'GET', 'HEAD', 'POST']],
      [ARCHIVE_CLEAR_PATH, ['DELETE', 'POST']],
      [SESSION_WORKSPACE_ARCHIVE_PATH, ['DELETE', 'POST']],
      [ARCHIVE_RESTORE_PATH, ['POST']],
      [OPEN_PATH_PATH, ['POST']],
    ]

    for (const [path, expected] of matrix) {
      const response = await fetch(url(path), { method: 'OPTIONS', headers: headers() })
      expect(response.status, `${path} 未声明 OPTIONS，必须 405`).toBe(405)
      expect(allowMethods(response), `${path} 的 allow 集合必须与注册行一致`).toEqual(expected)
    }
  })

  it('[反向] 验证取消归档缺 sessionId 返回 400 且未知 id 幂等返回 ok', async () => {
    const missing = await fetch(url(ARCHIVE_RESTORE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: '{}',
    })
    expect(missing.status, '缺 sessionId 必须 400').toBe(400)
    expect(await missing.json() as ErrorPayload, '缺参文案必须逐字相等').toEqual({ ok: false, error: 'invalid-session-id' })

    const unknown = await fetch(url(ARCHIVE_RESTORE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionId: 'does-not-exist' }),
    })
    expect(unknown.status, '未归档的 id 不是领域错误，实测非 400 也非 500').toBe(200)
    expect(await unknown.json() as { ok?: boolean }, '账本移除对缺失 id 为空操作，整体幂等成功').toEqual({ ok: true })

    await expectArchiveEmpty()
  })

  it('[反向] 验证工作区批量归档对非字符串 id 的当前行为', async () => {
    const unhandledError: UnhandledErrorPayload = { status: 500, unhandled: true, message: 'HTTPError' }

    const response = await fetch(url(SESSION_WORKSPACE_ARCHIVE_PATH), {
      method: 'POST',
      headers: headers(JSON_HEADERS),
      body: JSON.stringify({ sessionIds: [123] }),
    })

    expect(response.status, '非字符串项被 String() 强转后放行，落到宿主未处理异常（实测修正，见 G-SESS-5）').toBe(500)
    expect(await response.json() as UnhandledErrorPayload, '响应体必须是宿主未处理异常的标准载荷').toEqual(unhandledError)

    await expectArchiveEmpty()
  })
})
