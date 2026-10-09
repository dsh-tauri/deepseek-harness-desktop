/**
 * 批次 09 · `dsh-tauri-experimental` 的宿主路由与折叠粘贴（契约见 `docs/specs/plugin.test.md`）。
 *
 * 宿主侧插件只读：两个 GET 端点把账本里的逐回合变更记录回传给客户端读数。判定依赖会话与工作区
 * 上下文，而 scratch 宿主不造会话，因此本批刻意只覆盖无会话条件下即可判定的分支：入参校验、
 * 会话缺失、方法矩阵。`GET /live` 对未知会话的语义未确认，不写用例以免编造预期。
 *
 * 客户端侧覆盖折叠粘贴：>500 字落成官方引用 chip 且编辑器不留原文，≤500 字原样插入。
 *
 * 断言对象是外部世界（HTTP 状态码、响应字节与真实页面 DOM），不采信插件自报。宿主复用
 * globalSetup 的共享实例（已挂载 dsh-tauri-experimental），不另起进程。
 */

import type { Browser } from 'playwright'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { launchDshBrowser, newDshPage } from '../support/browser'

const SUMMARY_PATH = '/api/tauri/experimental/summary'
const LIVE_PATH = '/api/tauri/experimental/live'

/** 插件自有数据目录（`$DSH_HOME/<feature>`，账本与私有快照仓都在其下）。 */
const FEATURE_DIR = 'dsh-tauri-experimental'

/** 两条只声明 GET 的读路径。 */
const READ_PATHS = [SUMMARY_PATH, LIVE_PATH] as const

/** 只读路由公布的方法集合，按集合比较。 */
const READ_ONLY_ALLOW = ['GET', 'HEAD']

interface ErrorBody {
  error?: string
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

/** `allow` 成员顺序属实现细节，按集合比较。 */
function allowMethods(response: Response): string[] {
  return (response.headers.get('allow') ?? '').split(',').map(entry => entry.trim()).filter(Boolean).sort()
}

/** 插件数据目录的递归清单；目录不存在即「什么都没落盘」。 */
function featureDirEntries(): string[] {
  const dir = join(inject('dshHome'), FEATURE_DIR)
  if (!existsSync(dir))
    return []
  return readdirSync(dir, { recursive: true }).map(entry => String(entry)).sort()
}

describe('宿主路由：入参与会话校验', () => {
  it('[反向] 验证两个端点缺 sessionId 均返回 400', async () => {
    const before = featureDirEntries()

    for (const path of READ_PATHS) {
      const response = await fetch(url(path), { headers: apiHeaders() })

      expect(response.status, `GET ${path} 不带查询串必须在读账本之前被拒`).toBe(400)
      expect(
        await response.json() as ErrorBody,
        `GET ${path} 的拒绝理由必须是缺少入参，而不是会话或工作区问题`,
      ).toEqual({ error: '缺少 sessionId' })
    }

    expect(featureDirEntries(), '入参校验必须在读账本之前返回，一个字节都不许落盘').toEqual(before)
  })

  it('[反向] 验证未知会话的摘要返回 404', async () => {
    const response = await fetch(url(`${SUMMARY_PATH}?sessionId=does-not-exist`), { headers: apiHeaders() })

    expect(response.status, '未登记的会话必须 404，而不是 400 或 500').toBe(404)
    expect(
      await response.json() as ErrorBody,
      '会话缺失与入参缺失必须是两条可区分的理由',
    ).toEqual({ error: '会话不存在或尚未就绪' })
  })
})

describe('宿主路由：方法矩阵', () => {
  it('验证两条路径的方法集合（只有 GET）', async () => {
    for (const path of READ_PATHS) {
      const preflight = await fetch(url(path), { method: 'OPTIONS', headers: apiHeaders() })

      expect(preflight.status, `OPTIONS ${path} 未声明，必须走原生 405`).toBe(405)
      expect(
        allowMethods(preflight),
        `OPTIONS ${path} 的 allow 必须公布 GET / HEAD（GET 隐含）`,
      ).toEqual(READ_ONLY_ALLOW)

      const post = await fetch(url(path), {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: '{}',
      })

      expect(post.status, `POST ${path} 只声明了 GET，必须 405`).toBe(405)
      expect(
        allowMethods(post),
        `POST ${path} 的 allow 不得把 POST 说成可用，且必须指出真正可用的读方法`,
      ).toEqual(READ_ONLY_ALLOW)
    }
  })
})

/** 官方 composer 编辑器根（上游 `ComposerContentEditable` 的 `data-composer-input` 锚点）。 */
const COMPOSER_INPUT = '[data-composer-card] [data-composer-input]'

/**
 * 会话就绪的 composer 编辑器根：官方在会话尚未入库时把 `data-phase` 钉在 `inert`
 * （无会话的「选择工作区」占位态），此时插件按契约不接管粘贴
 * （`packages/dsh-tauri-experimental/src/client/register/paste-collapse.ts` 要求列表快照的 `current` 在位）。
 */
const COMPOSER_READY = `${COMPOSER_INPUT}:not([data-phase="inert"])`

/**
 * 折叠粘贴后的引用 chip 宿主：官方 `ReferenceChipNode.createDOM` 写的 `data-composer-chip`，
 * 其值是本插件注册的引用源名（`packages/dsh-tauri-experimental/src/client/constants/index.ts` 的 `PASTE_CHIP_SOURCE`）。
 */
const PASTE_CHIP = '[data-composer-chip="dsh-tauri-experimental-paste"]'

/** 官方侧边栏「新建会话」按钮（官方 sidebar 词典 `session.new.label`）。 */
const SIDEBAR_NEW_SESSION = 'button[aria-label="新建会话"]:visible'

/** `dsh-tauri-ui` 接管后的英雄区工作区 chip：本批的就绪锚点。 */
const HERO_WORKSPACE_CHIP = '[data-hero-workspace]'

/** 长粘贴夹具：首行是 chip 标题来源，整体远超 500 字阈值（`register/paste-collapse.utils.ts`）。 */
const LONG_PASTE = `### 环境信息 app:版本 1.0\n${'日志行'.repeat(200)}`

/** 阈值内夹具：必须原样进入编辑器。 */
const SHORT_PASTE = '短文本'.repeat(100)

/**
 * 在 composer 编辑器上派发一次合成粘贴事件。
 *
 * 真实剪贴板不可读（Playwright 无剪贴板权限），而官方 paste 命令本身也接受合成事件，
 * 因此这里按官方 `DataTransfer` + `ClipboardEvent` 的形态构造，只替换事件来源。
 * @returns 编辑器是否在位（不在位时本用例没有粘贴落点）。
 */
async function syntheticPaste(frame: import('playwright').Frame, text: string): Promise<{ editorFound: boolean }> {
  await frame.locator(COMPOSER_INPUT).click()
  return await frame.evaluate((payload) => {
    const editor = document.querySelector(payload.editorSelector)
    if (!(editor instanceof HTMLElement))
      return { editorFound: false }
    editor.focus()
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', payload.text)
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer }))
    return { editorFound: true }
  }, { editorSelector: COMPOSER_INPUT, text })
}

/**
 * 点侧边栏「新建会话」并等到 composer 会话就绪。
 *
 * 新会话由宿主异步入库：编辑器 DOM 在会话在库之前就已挂载，停在官方 `data-phase="inert"`
 * 的「选择工作区」占位态；此时粘贴既不会折叠也不会落文。就绪信号必须取会话输入面本身
 * （`data-phase` 由官方 `input?.phase ?? "inert"` 出具），而不是编辑器是否出现。
 */
async function openNewSessionComposer(frame: import('playwright').Frame): Promise<void> {
  await frame.locator(SIDEBAR_NEW_SESSION).first().click()
  await expect.poll(
    async () => await frame.locator(COMPOSER_READY).count(),
    { timeout: 20_000, message: '新建会话后 composer 必须进入会话就绪态（脱离官方 data-phase="inert" 占位态），否则粘贴没有落点' },
  ).toBe(1)
}

describe('L2 折叠粘贴', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchDshBrowser()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('验证超过 500 字的粘贴折叠成引用 chip，chip 文案带首行与字数', async () => {
    const app = await newDshPage(browser, { ready: HERO_WORKSPACE_CHIP })
    try {
      await openNewSessionComposer(app.frame)

      const paste = await syntheticPaste(app.frame, LONG_PASTE)
      expect(paste.editorFound, '夹具前置：composer 编辑器必须在位').toBe(true)

      await expect.poll(
        async () => await app.frame.locator(PASTE_CHIP).count(),
        { timeout: 10_000, message: '超过 500 字的粘贴必须折叠成引用 chip' },
      ).toBe(1)
      expect(
        await app.frame.locator(PASTE_CHIP).first().textContent(),
        'chip 文案必须是「粘贴内容首行 · 字数」（本插件词典提供，中文语境下为「… 字」）',
      ).toBe(`### 环境信息 app:版本 1.0 · ${LONG_PASTE.length} 字`)
      expect(
        await app.frame.locator(COMPOSER_INPUT).first().textContent(),
        '原文不得作为一大串文字留在编辑器里',
      ).not.toContain(LONG_PASTE)

      expect(app.errors, '折叠粘贴不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证 500 字以内的粘贴不折叠，原样进入编辑器', async () => {
    const app = await newDshPage(browser, { ready: HERO_WORKSPACE_CHIP })
    try {
      await openNewSessionComposer(app.frame)

      const paste = await syntheticPaste(app.frame, SHORT_PASTE)
      expect(paste.editorFound, '夹具前置：composer 编辑器必须在位').toBe(true)

      await expect.poll(
        async () => await app.frame.locator(COMPOSER_INPUT).first().textContent() ?? '',
        { timeout: 10_000, message: '500 字以内的粘贴必须原样出现在编辑器里' },
      ).toContain(SHORT_PASTE)
      expect(await app.frame.locator(PASTE_CHIP).count(), '500 字以内不得出现折叠 chip').toBe(0)

      expect(app.errors, '阈值内的粘贴不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
