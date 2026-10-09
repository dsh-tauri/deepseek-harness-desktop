/**
 * 批次 10 · `dsh-tauri-model` 的模型设置页 + 其自有的模型配置宿主路由
 * （L1/L2 契约见 `docs/specs/plugin.test.md`）。
 *
 * 插件是官方 `ui-settings-models` 的 fork：除 `webserver/index-inject` 的页面全局注入外，
 * 本仓库自有的模型配置路由（打开配置文件 / 端点探测 / 预设表）也由它注册，因此宿主契约
 * 按 `dsh-tauri-model` 的 base 断言。`settings.yaml` 的真实解析与
 * `GET /presets?force=true` 的上游下载由 `packages/dsh-tauri-model/src/host/service/`
 * 下的 unit 用例覆盖，不在 L2 重复。
 *
 * 断言对象是外部世界（HTTP 状态码、响应字节、scratch `DSH_HOME` 的文件状态、真实 DOM 结构），
 * 不采信插件自报。
 *
 * 宿主复用 globalSetup 的共享实例，不另起进程。
 */

import type { Browser } from 'playwright'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  APP_MODAL,
  appUrl,
  dismissAppModals,
  expectNoSyntheticFallbacks,
  launchDshBrowser,
  newDshPage,
  openSettings,
  selectSettingsSection,
  SETTINGS_CONTENT,
  waitForCredentialModal,
} from '../support/browser'

const PRESETS_PATH = '/api/tauri/model/presets'
const ENDPOINT_MODELS_PATH = '/api/tauri/model/endpoint/models'
const CONFIG_OPEN_PATH = '/api/tauri/model/config/open'

/** 设置文件名（`packages/dsh-tauri-model/src/shared/constants.ts`）。 */
const SETTINGS_FILE = 'settings.yaml'

/** 成功响应必须**恰为**这六个字段——多一个都说明契约变了。 */
const PRESETS_FIELDS = ['ok', 'source', 'fetchedAt', 'stale', 'count', 'presets'] as const

/** 密钥字段名黑名单：服务端从不回显凭据（G-MC-1）。 */
const SECRET_FIELDS = ['apiKey', 'api_key', 'key', 'token'] as const

/**
 * 模型页的结构锚点：cssr 运行期类名保留官方语义
 * （`packages/dsh-tauri-model/src/client/models/styles.ts`）。
 * 官方模型页没有标题行类名，标题是 `<h2 class="…title">`。
 */
const MODELS_TITLE = '[class*="title"]'
const MODELS_PROVIDER_CARD = '[class*="rowCard"],[class*="setupCard"]'
const MODELS_ADD_ACTIONS = '[class*="addActions"]'

/** 空态下页脚操作区的按钮文案（官方 0.1.7 文案），不含任何宽泛词。 */
const MODELS_ADD_LABELS = ['添加模型提供商', '自定义模型 API'] as const

interface PresetsBody {
  ok?: boolean
  source?: unknown
  fetchedAt?: unknown
  stale?: unknown
  count?: unknown
  presets?: unknown
}

interface ErrorBody {
  ok?: boolean
  error?: unknown
}

interface OpenBody {
  ok?: boolean
  path?: unknown
  opened?: unknown
}

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

function secretFieldsIn(body: unknown): string[] {
  const text = JSON.stringify(body)
  return SECRET_FIELDS.filter(field => text.includes(field))
}

describe('宿主路由：预设表', () => {
  it('验证预设端点返回六个字段且 count 与 presets 长度一致', async () => {
    // 预设表来自公网上游：不种缓存就会在离线机器上退化成 502（实测），断言随机器漂移。
    // 这里按被测实现自己的缓存格式（`$DSH_HOME/dsh-tauri-model/model-presets.json`，
    // 24h TTL 内命中即返回）种一份新鲜载荷，让「200 + 六字段契约」确定性可验、与外网解耦。
    const cachePath = join(inject('dshHome'), 'dsh-tauri-model', 'model-presets.json')
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({
      source: 'https://e2e.invalid/presets.json',
      fetchedAt: new Date().toISOString(),
      presets: { 'e2e-fixture': [1, 2, 3, 4] },
    }))

    const response = await fetch(url(PRESETS_PATH), { headers: apiHeaders() })

    expect(response.status, 'TTL 内命中本地缓存必须 200，且不依赖外网可达').toBe(200)

    const body = await response.json() as PresetsBody
    expect(Object.keys(body).sort(), '成功响应必须恰为六个字段').toEqual([...PRESETS_FIELDS].sort())
    expect(body.ok, 'ok 必须恰为 true').toBe(true)
    expect(typeof body.source, 'source 必须是上游 URL 字符串').toBe('string')
    expect(body.source, 'source 必须是非空上游地址').not.toBe('')
    expect(typeof body.fetchedAt, 'fetchedAt 必须是抓取时间字符串').toBe('string')
    expect(Number.isFinite(Date.parse(body.fetchedAt as string)), 'fetchedAt 必须可解析为时间').toBe(true)
    expect(typeof body.stale, 'stale 必须是布尔值').toBe('boolean')
    expect(typeof body.count, 'count 必须是数字').toBe('number')
    expect(body.presets, 'presets 必须是对象').toBeTypeOf('object')
    expect(body.presets, 'presets 不得为 null').not.toBeNull()

    const presets = body.presets as Record<string, unknown>
    expect(Object.keys(presets).length, 'presets 不得为空表').toBeGreaterThan(0)
    expect(body.count, 'count 必须等于 presets 的条目数').toBe(Object.keys(presets).length)
    for (const row of Object.values(presets))
      expect(Array.isArray(row) && row.length === 4, '每条预设必须是四元数组').toBe(true)
  })
})

describe('宿主路由：端点探测', () => {
  it('[反向] 验证未配置 endpoint 的命名空间返回 502 且不回显凭据字段', async () => {
    const response = await fetch(url(`${ENDPOINT_MODELS_PATH}?ns=nope`), { headers: apiHeaders() })

    expect(response.status, 'settings 命名空间没有 endpoint 时必须 502，而不是 200 或 500').toBe(502)

    const body = await response.json() as ErrorBody
    expect(body.ok, '失败响应必须显式 ok:false').toBe(false)
    expect(typeof body.error, 'error 必须是字符串').toBe('string')
    expect((body.error as string).length, 'error 必须非空').toBeGreaterThan(0)
    expect(secretFieldsIn(body), '失败响应不得出现任何形如密钥的字段').toEqual([])
    expect(secretFieldsIn(response.headers.get('set-cookie') ?? ''), '响应头同样不得带凭据').toEqual([])
  })
})

describe('宿主路由：打开设置文件', () => {
  it('验证打开配置端点返回 scratch DSH_HOME 下的路径与打开方式', async () => {
    const home = inject('dshHome')
    const response = await fetch(url(CONFIG_OPEN_PATH), { method: 'POST', headers: apiHeaders() })

    expect(response.status, '打开动作本身成功时必须 200，失败才是 500').toBe(200)

    const body = await response.json() as OpenBody
    expect(body.ok, 'ok 必须恰为 true').toBe(true)
    expect(typeof body.path, 'path 必须是字符串').toBe('string')
    expect(body.path, 'path 必须是绝对路径').toMatch(/^[A-Z]:\\|^\//)
    expect(
      String(body.path).startsWith(home),
      `path 必须位于 scratch DSH_HOME 之下（实测 path=${String(body.path)} home=${home}）`,
    ).toBe(true)
    expect(['file', 'directory'], 'opened 只能取 file / directory').toContain(body.opened)
  })

  it('验证设置文件缺失时退回打开目录', async () => {
    const home = inject('dshHome')
    const settingsPath = join(home, SETTINGS_FILE)

    // 前置由用例自建：同车道先跑的浏览器用例确认「内测声明」会落 settings.yaml，
    // 共享 scratch DSH_HOME 因此不再保证「文件缺失」。显式移除，确定性覆盖退目录分支。
    rmSync(settingsPath, { force: true })
    expect(existsSync(settingsPath), '前置：settings.yaml 必须已移除').toBe(false)

    const response = await fetch(url(CONFIG_OPEN_PATH), { method: 'POST', headers: apiHeaders() })

    expect(response.status, '缺文件时退回打开目录，仍是成功 200').toBe(200)

    const body = await response.json() as OpenBody
    expect(body.ok).toBe(true)
    expect(body.opened, '文件不存在时必须恰为 directory').toBe('directory')
    expect(body.path, '退回目录时 path 是 DSH_HOME 目录本身').toBe(home)
  })
})

describe('L2 客户端', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchDshBrowser()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('验证模型设置分区由本插件接管且不重复', async () => {
    const app = await newDshPage(browser)
    try {
      await openSettings(app.page, app.frame, app.syntheticFallbacks)

      const nav = await app.frame.evaluate(() =>
        Array.from(document.querySelectorAll('nav[aria-label] button')).map(button => button.textContent?.trim() ?? ''))

      expect(nav, '设置侧栏必须注册模型分区').toContain('模型')
      expect(nav.filter(label => label.includes('模型')).length, 'patch 关闭官方 models 后「模型」分区必须恰好一个').toBe(1)

      await selectSettingsSection(app.page, app.frame, '模型', app.syntheticFallbacks)

      const panel = await app.frame.evaluate((contentSelector: string) => {
        const content = document.querySelector(contentSelector)
        return {
          text: content?.textContent?.trim().slice(0, 200) ?? '',
          alerts: Array.from(content?.querySelectorAll('[role="alert"]') ?? []).map(alert => alert.textContent?.trim()),
        }
      }, SETTINGS_CONTENT)
      expect(panel.text, '模型分区必须真的渲染出内容').not.toBe('')
      expect(panel.text, '模型分区必须落到本插件的模型页（含提供商/模型字样）').toMatch(/提供商|模型/)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '分区注册与渲染不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证官方提供商引导弹层由本插件的 onboarding 槽位渲染且可收起', async () => {
    const app = await newDshPage(browser, { dismissModals: false })
    try {
      const modal = await waitForCredentialModal(app.page, app.frame, app.syntheticFallbacks)
      const state = await modal.evaluate((element) => {
        const text = element.textContent ?? ''
        return {
          hasDeepseek: /DeepSeek/.test(text),
          inputCount: element.querySelectorAll('input,textarea').length,
          alerts: Array.from(element.querySelectorAll('[role="alert"]')).map(alert => alert.textContent?.trim()),
        }
      })

      expect(state.hasDeepseek, '引导弹层必须渲染官方 DeepSeek 提供商卡片').toBe(true)
      expect(state.inputCount, '引导卡片必须渲染可输入的 API 密钥字段').toBeGreaterThan(0)
      expect(state.alerts, '首次进入不得出现错误条').toEqual([])
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '引导弹层渲染不得抛出应用级错误').toEqual([])

      await dismissAppModals(app.page, app.frame, app.syntheticFallbacks)
      await expect.poll(
        async () => await app.frame.locator(APP_MODAL).count(),
        { timeout: 15_000, message: '点「稍后配置」后引导弹层必须收起' },
      ).toBe(0)
    }
    finally {
      await app.close()
    }
  })

  it('验证模型页渲染提供商卡片与页脚操作区', async () => {
    const app = await newDshPage(browser)
    try {
      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      await selectSettingsSection(app.page, app.frame, '模型', app.syntheticFallbacks)

      const state = await app.frame.evaluate(({ title, providerCard, addActions, contentSelector }) => {
        const content = document.querySelector(contentSelector)
        const footer = content?.querySelector(addActions)
        return {
          titles: content?.querySelectorAll(title).length ?? 0,
          providerCards: content?.querySelectorAll(providerCard).length ?? 0,
          footerButtons: Array.from(footer?.querySelectorAll('button') ?? []).map(button => button.textContent?.trim() ?? ''),
          buttons: content?.querySelectorAll('button').length ?? 0,
          alerts: Array.from(content?.querySelectorAll('[role="alert"]') ?? []).map(alert => alert.textContent?.trim()),
          navLabels: Array.from(document.querySelectorAll('nav[aria-label] button')).map(button => button.textContent?.trim()),
        }
      }, { title: MODELS_TITLE, providerCard: MODELS_PROVIDER_CARD, addActions: MODELS_ADD_ACTIONS, contentSelector: SETTINGS_CONTENT })

      expect(state.titles, '模型页必须渲染标题行（证明走的是正常分支而非加载失败分支）').toBeGreaterThan(0)
      expect(
        state.providerCards > 0 || MODELS_ADD_LABELS.some(label => state.footerButtons.includes(label)),
        `模型页必须为提供商渲染卡片 ${MODELS_PROVIDER_CARD}，或渲染带「添加模型提供商」按钮的明确空态`
        + `（实际页脚按钮：${JSON.stringify(state.footerButtons)}）`,
      ).toBe(true)
      expect(state.buttons, '模型页必须渲染可交互的页脚操作区').toBeGreaterThan(0)
      expect(state.alerts, '预设可用时不得出现错误条').toEqual([])
      expect(state.navLabels.filter(label => label === '模型').length, '切换到模型页后同 id 分区不得重复').toBe(1)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '模型页渲染不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('[反向] 验证模型页不依赖预设上游（预设只在显式触发时拉取）', async () => {
    const app = await newDshPage(browser)
    let stubbedCalls = 0
    try {
      await app.page.route(`${appUrl(PRESETS_PATH)}`, async (route) => {
        stubbedCalls += 1
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'e2e-stubbed-upstream-failure' }),
        })
      })

      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      await selectSettingsSection(app.page, app.frame, '模型', app.syntheticFallbacks)
      await new Promise(resolve => setTimeout(resolve, 2_000))

      const state = await app.frame.evaluate((contentSelector: string) => {
        const content = document.querySelector(contentSelector)
        return {
          text: content?.textContent?.trim().slice(0, 240) ?? '',
          buttons: content?.querySelectorAll('button').length ?? 0,
          inputs: content?.querySelectorAll('input,textarea').length ?? 0,
          errorLines: Array.from(content?.querySelectorAll('[role="alert"]') ?? []).map(alert => alert.textContent?.trim() ?? ''),
        }
      }, SETTINGS_CONTENT)

      expect(stubbedCalls, '模型页不得在加载时拉取预设上游：预设只由「自动配置所有模型」显式触发（该能力由本插件承载）').toBe(0)
      expect(state.text, '预设上游不可用时页面其余部分仍必须渲染（不是整页崩溃）').not.toBe('')
      expect(state.buttons, '失败时仍必须保留可交互入口').toBeGreaterThan(0)
      expect(state.inputs, '失败时仍必须保留可编辑字段').toBeGreaterThan(0)
      expect(state.errorLines, '预设失败不得让模型页出现 entry.error 级错误条').toEqual([])
      expectNoSyntheticFallbacks(app)
      expect(
        app.errors.filter(line => line.startsWith('PAGEERROR')),
        '预设 502 只允许留下浏览器对 502 响应的 console 记录，不得有未捕获异常',
      ).toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
