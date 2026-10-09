import type { Browser, BrowserContext, ElementHandle, Frame, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, inject } from 'vitest'

// ==========================================
// 1. 常量与选择器配置
// ==========================================

/** 同源嵌入宿主路径：只由 `page.route` 提供，真实 dsh 服务上不存在。 */
export const EMBEDDED_DOCUMENT_PATH = '/dsh-e2e-embed.html'

/** 被测页面的 iframe 尺寸；太小会把设置侧栏折成 Rail 形态，影响几何断言。 */
export const APP_FRAME_VIEWPORT = { width: 1400, height: 900 } as const

/**
 * 钉死的浏览器语言（产品的主语言）。
 *
 * dsh 客户端的初始语言来自 `navigator.languages` → `navigator.language`
 * （`dsh-client-locale` 的 `detectBrowserLocale`，都匹配不到才回落 `en`）。Playwright
 * 不指定 `locale` 时把语境交给宿主机，于是本车道大量以中文文案为锚（`宠物` / `模型` /
 * 页脚操作区文案…）的断言会变成「在中文开发机上恰好绿、在干净 runner 上找不到中文分区」。
 * 这里显式钉死，让断言只取决于产品，而不取决于运行机的系统语言。
 */
export const APP_LOCALE = 'zh-CN'

/**
 * 「没有 Tauri 宿主」这一环境事实导致的预期噪声。
 * Precise-match list to suppress false negatives.
 */
export const IGNORED_APP_ERRORS: readonly string[] = [
  'NODE_NOT_ANSWERED: invoke ',
]

/** 插件自身注入的元素用 `data-dsh-*`（`plugin.client.md` §4）。 */
export const SCHEDULER_ICON = '[data-dsh-scheduler-icon]'
export const WORKTREE_ICON = '[data-dsh-worktree-icon]'
export const WORKTREE_MODE_ANCHOR = '[data-dsh-tauri-worktree-mode-anchor]'
export const WORKTREE_SURFACE = '[data-dsh-worktree-surface]'
export const SESSION_ARCHIVE_ITEM = '[data-dsh-tauri-session-archive-item]'
export const SESSION_ARCHIVE_MENU_PATCHED = '[data-dsh-tauri-session-archive-menu-patched="1"]'
export const RUNNING_CHANGES = '[data-running-changes]'

/** 设置菜单里的桌宠条目与「该菜单已被补丁」标记（同上常量文件）。 */
export const PET_MENU_ITEM = '[data-dsh-tauri-pet-menu-item="1"]'
export const PET_MENU_PATCHED = '[data-dsh-tauri-pet-menu-patched="1"]'

/** dsh 内部结构（上游产物）：可用稳定结构性锚点。 */
export const SIDEBAR = '[data-slot="sidebar"]'
export const SIDEBAR_PANELLIST = '[data-slot="sidebar.panellist"]'
export const SETTINGS_TRIGGER = '[data-settings-trigger]'
export const SETTINGS_SIDEBAR = '[data-slot-sidebar="dsh-tauri-ui"]'
export const SETTINGS_SECTION_SLOT = '[data-slot="settings.section"]'
export const SETTINGS_NAV_ITEM = 'nav[aria-label] button'
/** 壳层自有设置菜单（浏览器态）的条目：官方 primitives 的 portal Menu 条目。 */
export const SETTINGS_MENU_ITEM = '[role="menuitem"]'
export const SETTINGS_MENU_LABEL = /^(设置|Settings)$/
export const SETTINGS_CONTENT = '[data-slot="settings.content"]'
export const SETTINGS_ONBOARDING = '[data-slot="settings.onboarding"]'
export const COMPOSER_CARD = '[data-composer-card]'
export const COMPOSER_INPUT_DOCK = '[data-slot="conversation.input.dock"]'
export const CONVERSATION_SESSION = '[data-slot="conversation.session"]'
export const SIDEBAR_ROW = 'button[class*="panelRow"]'

/** 阻塞式引导弹层选择器 */
export const APP_MODAL = '[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="settings"])'
export const APP_MODAL_CANCEL = 'div[class*="_editorActions"] > button'

// ==========================================
// 2. 类型定义与断言
// ==========================================

export interface DshPage {
  browser: Browser
  context: BrowserContext
  page: Page
  frame: Frame
  errors: string[]
  /** 本轮走合成事件兜底的调用点；用例用 `expectNoSyntheticFallbacks` 断言为空。 */
  syntheticFallbacks: SyntheticFallback[]
  close: () => Promise<void>
}

/** 一次「绕过命中测试的合成点击」记录。 */
export interface SyntheticFallback {
  /** 走兜底的调用点，如 `clickInFrame` / `openSettings` / `selectSettingsSection`。 */
  site: string
  /** 兜底目标的可读描述。 */
  target: string
}

export interface NewDshPageOptions {
  ready?: string
  path?: string
  dismissModals?: boolean
  viewport?: { width: number, height: number }
  hasTouch?: boolean
  isMobile?: boolean
}

/** 断言本轮没有任何合成事件兜底：真实指针点击必须自己点得通。 */
export function expectNoSyntheticFallbacks(app: DshPage): void {
  const detail = app.syntheticFallbacks.map(item => `${item.site} → ${item.target}`).join('; ')
  expect(
    app.syntheticFallbacks,
    `真实指针点击未生效，走了合成事件兜底（${detail || '无'}）`,
  ).toEqual([])
}

export function appUrl(path = '/'): string {
  return `${inject('dshBaseUrl')}${path}`
}

// ==========================================
// 3. 浏览器与 Context 基础构建
// ==========================================

export function launchDshBrowser(): Promise<Browser> {
  return chromium.launch()
}

export function newDshContext(browser: Browser, options: Pick<NewDshPageOptions, 'viewport' | 'hasTouch' | 'isMobile'> = {}): Promise<BrowserContext> {
  return browser.newContext({ viewport: options.viewport ?? APP_FRAME_VIEWPORT, hasTouch: options.hasTouch, isMobile: options.isMobile, locale: APP_LOCALE })
}

export async function addSessionCookie(context: BrowserContext): Promise<void> {
  const [name, ...rest] = inject('dshCookie').split('=')
  await context.addCookies([{ name, value: rest.join('='), url: inject('dshBaseUrl') }])
}

async function installEmbedRoute(page: Page, viewport: { width: number, height: number }): Promise<void> {
  const embedUrl = `${inject('dshBaseUrl')}${EMBEDDED_DOCUMENT_PATH}`
  const htmlContent = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;overflow:hidden">`
    + `<iframe id="dsh" src="/" style="display:block;width:${viewport.width}px;height:${viewport.height}px;border:0"></iframe>`
    + '</body></html>'

  await page.route(embedUrl, route =>
    route.fulfill({
      contentType: 'text/html',
      body: htmlContent,
    }))
}

/**
 * 一页的诊断采集状态：监听始终挂着（廉价），但只有失败路径才被读出来格式化。
 * `errors` 保持既有语义（已过滤 `IGNORED_APP_ERRORS`），其余字段只服务于失败现场报告。
 */
export interface AppDiagnostics {
  /** 未命中 `IGNORED_APP_ERRORS` 的错误，即用例断言读取的列表。 */
  errors: string[]
  /** 命中 `IGNORED_APP_ERRORS` 而被抑制的错误；诊断时按原始串打印，便于区分「真噪声」与「掩盖了真因」。 */
  ignored: string[]
  /** 4xx/5xx 响应，含 iframe 内的插件客户端 bundle 请求。 */
  httpErrors: string[]
  /** 请求层失败（连接被拒/中断/abort）。 */
  requestFailures: string[]
}

const DIAGNOSTIC_LIMIT = 40
const diagnosticsByPage = new WeakMap<Page, AppDiagnostics>()

/** 取（或首次建立）某一页的诊断状态；同一页重复调用只挂一次监听。 */
export function pageDiagnostics(page: Page): AppDiagnostics {
  const existing = diagnosticsByPage.get(page)
  if (existing)
    return existing

  const state: AppDiagnostics = { errors: [], ignored: [], httpErrors: [], requestFailures: [] }
  diagnosticsByPage.set(page, state)

  const record = (source: string, message: string): void => {
    const line = `${source} ${message.split('\n')[0]}`
    if (IGNORED_APP_ERRORS.some(ignored => line.includes(ignored))) {
      if (state.ignored.length < DIAGNOSTIC_LIMIT)
        state.ignored.push(line)
      return
    }
    state.errors.push(line)
  }

  page.on('pageerror', error => record('PAGEERROR', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      record('CONSOLE', message.text())
    }
  })
  page.on('response', (response) => {
    if (response.status() < 400 || state.httpErrors.length >= DIAGNOSTIC_LIMIT)
      return
    state.httpErrors.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`)
  })
  page.on('requestfailed', (request) => {
    if (state.requestFailures.length >= DIAGNOSTIC_LIMIT)
      return
    state.requestFailures.push(`REQFAIL ${request.failure()?.errorText ?? 'unknown'} ${request.url()}`)
  })
  return state
}

/** 采集父页与 frame 的错误；返回的数组由用例在断言前读取。 */
export function collectAppErrors(page: Page): string[] {
  return pageDiagnostics(page).errors
}

// ==========================================
// 4. 失败现场诊断
// ==========================================

/**
 * frame 内可序列化的现场快照。
 *
 * 刻意不读 `document.body.innerHTML` 全量：宿主页面在 CI 上体积不可控，只取计数、
 * 已注入的 `data-dsh-*` 属性表、插件 combo 脚本与启动图，足以区分
 * 「插件客户端没进启动图」/「进了但浏览器侧没跑起来」/「跑起来但没注入 DOM」。
 */
interface FrameSnapshot {
  readyState: string
  hasRoot: boolean
  rootChildren: number
  rootHtmlLength: number
  bodyHtmlLength: number
  slotCount: number
  slots: string[]
  dshAttrs: string[]
  pluginScripts: string[]
  bootModules: number
  bootIds: string[]
  loaderKeys: string[]
  loaderMode: string
  loaderPending: number
  settingsTrigger: boolean
  settingsSidebar: boolean
}

const SNAPSHOT_TIMEOUT_MS = 5_000
const SNAPSHOT_ELEMENT_BUDGET = 4_000
/** 模型引导会在宿主 ready 锚点之后异步挂载；每个隔离浏览器 context 都要留一次发现窗口。 */
const INITIAL_MODAL_DISCOVERY_MS = 3_000

/** 采集 frame 内快照；自身绝不抛错、绝不拖死用例（超时降级成一行文本）。 */
async function captureFrameSnapshot(frame: Frame): Promise<FrameSnapshot | string> {
  const dump = frame.evaluate((budget: number) => {
    const doc = document
    const root = doc.querySelector('#root')
    const slots = Array.from(doc.querySelectorAll('[data-slot]'), el => el.getAttribute('data-slot') ?? '')
      .filter(Boolean)

    const dshAttrs: string[] = []
    const all = doc.querySelectorAll('*')
    for (let index = 0; index < all.length && index < budget && dshAttrs.length < 40; index += 1) {
      const el = all[index] as Element
      for (const attr of Array.from(el.attributes)) {
        if (!attr.name.startsWith('data-dsh-'))
          continue
        const entry = `<${el.tagName.toLowerCase()} ${attr.name}${attr.value === '' ? '' : `="${attr.value}"`}>`
        if (!dshAttrs.includes(entry))
          dshAttrs.push(entry)
      }
    }

    const pluginScripts = Array.from(doc.scripts, script => script.src)
      .filter(src => src.includes('/plugins/'))
      .slice(0, 20)

    const globals = window as unknown as Record<string, unknown>
    const boot = globals.__DSH_BOOT__ as { modules?: { id?: unknown }[] } | undefined
    const loader = globals.__ModuleLoader__ as { mode?: unknown, pendingQueue?: unknown[] } | undefined
    const modules = Array.isArray(boot?.modules) ? boot.modules : []

    return {
      readyState: doc.readyState,
      hasRoot: root !== null,
      rootChildren: root?.childElementCount ?? -1,
      rootHtmlLength: root?.innerHTML.length ?? -1,
      bodyHtmlLength: doc.body?.innerHTML.length ?? -1,
      slotCount: slots.length,
      slots: [...new Set(slots)].slice(0, 30),
      dshAttrs,
      pluginScripts,
      bootModules: Array.isArray(boot?.modules) ? modules.length : -1,
      bootIds: modules.map(item => String(item?.id)).slice(0, 40),
      loaderKeys: loader === undefined ? [] : Object.keys(loader),
      loaderMode: String(loader?.mode ?? 'n/a'),
      loaderPending: Array.isArray(loader?.pendingQueue) ? loader.pendingQueue.length : -1,
      settingsTrigger: doc.querySelector('[data-settings-trigger]') !== null,
      settingsSidebar: doc.querySelector('[data-slot-sidebar="dsh-tauri-ui"]') !== null,
    }
  }, SNAPSHOT_ELEMENT_BUDGET)

  try {
    return await Promise.race([
      dump,
      new Promise<string>(resolve => setTimeout(resolve, SNAPSHOT_TIMEOUT_MS, 'SNAPSHOT_TIMEOUT')),
    ])
  }
  catch (error) {
    return `SNAPSHOT_FAILED ${(error as Error).message.split('\n')[0]}`
  }
}

/**
 * 生成失败现场报告：DOM 锚点计数、插件注入痕迹、客户端启动图与启动期的错误/网络失败。
 * 只在等待锚点失败时调用，成功路径不产生任何输出。
 */
export async function describePageState(page: Page, frame: Frame): Promise<string> {
  const state = pageDiagnostics(page)
  const snapshot = await captureFrameSnapshot(frame)
  const lines: string[] = []
  const pushList = (title: string, items: readonly string[], empty: string): void => {
    lines.push(`${title} [${items.length}]${items.length === 0 ? ` ${empty}` : ''}`)
    for (const item of items)
      lines.push(`    ${item}`)
  }

  lines.push(`frames=${page.frames().length} mainUrl=${page.mainFrame().url()} frameUrl=${frame.url()} isMainFrame=${frame === page.mainFrame()}`)

  if (typeof snapshot === 'string') {
    lines.push(snapshot)
  }
  else {
    const rootState = snapshot.hasRoot
      ? `children=${snapshot.rootChildren} html=${snapshot.rootHtmlLength}`
      : 'MISSING'
    lines.push(`readyState=${snapshot.readyState} #root=${rootState} bodyHtml=${snapshot.bodyHtmlLength}`)
    lines.push(`[data-slot] count=${snapshot.slotCount} values=${snapshot.slots.join(',') || '(none)'}`)
    lines.push(`__DSH_BOOT__.modules=${snapshot.bootModules} ids=${snapshot.bootIds.join(',') || '(none)'}`)
    lines.push(`__ModuleLoader__ keys=${snapshot.loaderKeys.join(',') || '(none)'} mode=${snapshot.loaderMode} pendingQueue=${snapshot.loaderPending}`)
    lines.push(`pluginAnchors settingsTrigger=${snapshot.settingsTrigger} settingsSidebar=${snapshot.settingsSidebar}`)
    pushList('pluginComboScripts', snapshot.pluginScripts, '(none: 启动 HTML 里没有任何 /plugins/ 脚本)')
    pushList('injectedDataDshAttrs', snapshot.dshAttrs, '(none: 没有任何插件注入的元素)')
  }

  pushList('appErrors(未命中忽略表)', state.errors, '(none)')
  pushList('ignoredAppErrors(命中 IGNORED_APP_ERRORS，原始串)', state.ignored, '(none)')
  pushList('httpErrors(status>=400，含 iframe)', state.httpErrors, '(none)')
  pushList('requestFailures', state.requestFailures, '(none)')
  return lines.join('\n')
}

/** 在锚点等待超时时，把「等不到」升级成「为什么等不到」。 */
async function failWithDiagnostics(page: Page, frame: Frame, reason: string, cause: unknown): Promise<never> {
  const report = await describePageState(page, frame)
  throw new Error(
    `${reason}：${(cause as Error).message.split('\n')[0]}\n--- 失败现场 ---\n${report}`,
    { cause },
  )
}

// ==========================================
// 5. 页面初始化与生命周期编排
// ==========================================

/**
 * 在当前 browser 上新建一个内嵌 dsh 页面并等待界面可用。
 *
 * 默认就绪锚点取核心 dsh 的结构性槽位 `SIDEBAR`（`[data-slot="sidebar"]`），不取任何插件
 * 注入的元素：`SETTINGS_TRIGGER` 由 `dsh-tauri-ui` 渲染，在 Ubuntu CI 上可能迟迟不出现，
 * 而它缺席并不表示 dsh 未就绪——`SIDEBAR` 是上游产物，也是各插件自己判定「侧栏就绪」时
 * 读取的同一个锚点。需要断言插件产物的用例必须显式传 `{ ready: SETTINGS_TRIGGER }` 等，不依赖默认值。
 */
export async function newDshPage(
  browser: Browser,
  options: NewDshPageOptions = {},
): Promise<DshPage> {
  const context = await newDshContext(browser, options)
  await addSessionCookie(context)

  const page = await context.newPage()
  const errors = collectAppErrors(page)
  const syntheticFallbacks: SyntheticFallback[] = []
  const isEmbedded = options.path === undefined

  if (isEmbedded) {
    await installEmbedRoute(page, options.viewport ?? APP_FRAME_VIEWPORT)
  }

  await page.goto(appUrl(options.path ?? EMBEDDED_DOCUMENT_PATH))

  let frame = page.mainFrame()
  if (isEmbedded) {
    const candidate = page.frames().find(item => item !== page.mainFrame())
    expect(candidate, '嵌入文档必须产出被测 iframe').toBeDefined()
    frame = candidate!
  }

  await frame.waitForLoadState('domcontentloaded')

  const ready = options.ready ?? SIDEBAR
  try {
    await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 30_000 })
  }
  catch (error) {
    await failWithDiagnostics(page, frame, `就绪锚点 ${ready} 在 30s 内未出现`, error)
  }

  if (options.dismissModals ?? true) {
    await dismissAppModals(page, frame, syntheticFallbacks, 20_000, INITIAL_MODAL_DISCOVERY_MS)
  }

  return {
    browser,
    context,
    page,
    frame,
    errors,
    syntheticFallbacks,
    close: async () => {
      await page.close().catch(() => {})
      await context.close()
    },
  }
}

/** 便捷封装：自建 browser + 页面（单条用例自足时用）。 */
export async function openDshApp(options: NewDshPageOptions = {}): Promise<DshPage> {
  const browser = await launchDshBrowser()
  const app = await newDshPage(browser, options)
  return {
    ...app,
    close: async () => {
      await app.close()
      await browser.close()
    },
  }
}

// ==========================================
// 6. 交互与 DOM 事件辅助
// ==========================================

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 等某一个元素从 DOM 移除。 */
async function waitForDetached(handle: ElementHandle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const isConnected = await handle.evaluate(el => el.isConnected).catch(() => false)
    if (!isConnected)
      return
    await delay(100)
  }
  throw new Error(`点击关闭项后弹层在 ${timeoutMs}ms 内仍未从 DOM 移除`)
}

/** 帧内合成 `click`：绕过命中测试直接派发事件。 */
async function dispatchSyntheticClick(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * 用真实指针事件点击。缺失几何信息或不可命中时，退回合成点击并记录兜底。
 */
export async function clickInFrame(
  page: Page,
  target: Locator,
  fallbacks?: SyntheticFallback[],
): Promise<void> {
  let box = await target.boundingBox()
  if (!box) {
    await target.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {})
    box = await target.boundingBox()
  }

  if (!box) {
    fallbacks?.push({ site: 'clickInFrame', target: target.toString() })
    await dispatchSyntheticClick(target)
    return
  }

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * 内部通用辅助：执行点击，并在预期属性未发生变化时降级为合成点击。
 */
async function clickWithFallback(
  page: Page,
  target: Locator,
  attrName: string,
  expectedVal: string,
  siteName: string,
  fallbackTargetDesc: string,
  fallbacks?: SyntheticFallback[],
  offsetX?: number,
): Promise<void> {
  const box = await target.boundingBox()
  if (offsetX !== undefined && box) {
    await page.mouse.click(box.x + Math.min(box.width / 2, offsetX), box.y + box.height / 2)
  }
  else {
    await clickInFrame(page, target, fallbacks)
  }

  if (await target.getAttribute(attrName) !== expectedVal) {
    fallbacks?.push({ site: siteName, target: fallbackTargetDesc })
    await dispatchSyntheticClick(target)
  }
}

// ==========================================
// 7. 弹层与设置面板特定操作
// ==========================================

/** 关掉当前帧内的一个阻塞弹层。 */
async function dismissOneModal(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
): Promise<boolean> {
  const dialog = frame.locator(APP_MODAL).first()
  if (await dialog.count() === 0)
    return false

  const snapshot = await dialog.elementHandle()
  if (!snapshot)
    return false

  const cancel = dialog.locator(APP_MODAL_CANCEL).first()
  const action = (await cancel.count() > 0) ? cancel : dialog.locator('button').first()

  if (await action.count() === 0) {
    throw new Error(
      `帧内存在阻塞弹层 ${APP_MODAL}，但取消容器 ${APP_MODAL_CANCEL} 与兜底 button 都不存在，无法关闭`,
    )
  }

  await clickInFrame(page, action, fallbacks)
  await waitForDetached(snapshot, 8_000)
  return true
}

/**
 * 确保帧内无阻塞弹层（可重入的闸）。
 * `discoveryMs` 只延长「尚未发现弹层」的启动观察期；发现并关闭后仍沿用 300ms 复核。
 */
export async function dismissAppModals(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
  timeoutMs = 20_000,
  discoveryMs = 0,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let discoveryDeadline = Math.min(deadline, Date.now() + discoveryMs)
  while (Date.now() < deadline) {
    if (await dismissOneModal(page, frame, fallbacks)) {
      discoveryDeadline = Date.now()
      continue
    }
    await delay(300)
    if (await dismissOneModal(page, frame, fallbacks)) {
      discoveryDeadline = Date.now()
      continue
    }
    if (Date.now() >= discoveryDeadline)
      return
  }

  const remaining = await frame.locator(APP_MODAL).count()
  throw new Error(
    `关闭阻塞弹层超时（${timeoutMs}ms）；当前帧仍有 ${remaining} 个 ${APP_MODAL}`
    + '（弹层一直没被点掉：检查它是否持续重挂，或点击被遮罩 / inert 吞掉）',
  )
}

/** 等「带凭据输入的 API Key 引导弹层」，返回它的 locator。 */
export async function waitForCredentialModal(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
  timeoutMs = 45_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const withInput = frame.locator(`${APP_MODAL}:has(input, textarea)`)
    if (await withInput.count() > 0) {
      return withInput.first()
    }

    if (await frame.locator(APP_MODAL).count() > 0) {
      await dismissOneModal(page, frame, fallbacks)
    }
    else {
      await delay(300)
    }
  }
  throw new Error('等待带凭据输入的 API Key 引导弹层超时')
}

/**
 * 点开设置入口并把菜单**停在展开态**，返回触发器的 locator。
 *
 * 桌宠开关是设置菜单里克隆出来的条目，只有菜单展开时才存在，因此断言它的用例必须在
 * 这一步停下；`openSettings` 会继续点「设置」条目把菜单收掉。
 */
export async function openSettingsMenu(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
): Promise<Locator> {
  await dismissAppModals(page, frame, fallbacks)
  const trigger = frame.locator(SETTINGS_TRIGGER).first()
  try {
    await trigger.waitFor({ state: 'attached', timeout: 20_000 })
  }
  catch (error) {
    await failWithDiagnostics(page, frame, `设置触发器 ${SETTINGS_TRIGGER} 在 20s 内未出现`, error)
  }

  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await clickWithFallback(
      page,
      trigger,
      'aria-expanded',
      'true',
      'openSettingsMenu',
      `${SETTINGS_TRIGGER} aria-expanded 未被指针点击改写`,
      fallbacks,
    )
  }

  await expect.poll(
    () => trigger.getAttribute('aria-expanded'),
    { timeout: 15_000, message: '点击设置入口后 aria-expanded 必须变为 true（设置菜单未展开）' },
  ).toBe('true')

  return trigger
}

/** 打开设置侧栏，返回触发器的 locator。 */
export async function openSettings(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
): Promise<Locator> {
  const trigger = await openSettingsMenu(page, frame, fallbacks)

  // 浏览器态（无桌面账号菜单）下触发器点开的是壳层自有设置菜单，还要再选中「设置」条目；
  // 桌面载体下官方账号菜单占据该座位，点开即是设置面板，不会有菜单条目。
  if (await frame.locator(SETTINGS_SECTION_SLOT).count() === 0) {
    const settingsItem = frame.locator(SETTINGS_MENU_ITEM).filter({ hasText: SETTINGS_MENU_LABEL }).first()
    if (await settingsItem.count() > 0)
      await settingsItem.click()
  }

  await frame.locator(SETTINGS_SECTION_SLOT).first().waitFor({ state: 'attached', timeout: 15_000 })
  return trigger
}

/** 点开设置侧栏里的某个分区，等 `aria-current` 激活。 */
export async function selectSettingsSection(
  page: Page,
  frame: Frame,
  title: string,
  fallbacks?: SyntheticFallback[],
): Promise<Locator> {
  await dismissAppModals(page, frame, fallbacks)
  const item = frame.locator(SETTINGS_NAV_ITEM, { hasText: title }).first()
  await item.waitFor({ state: 'attached', timeout: 15_000 })

  const box = await item.boundingBox()
  expect(box, `分区「${title}」的导航项必须有可见几何`).not.toBeNull()

  await clickWithFallback(
    page,
    item,
    'aria-current',
    'true',
    'selectSettingsSection',
    `分区「${title}」aria-current 未被指针点击改写`,
    fallbacks,
    40, // 点击偏移 X 坐标
  )

  await expect.poll(
    () => item.getAttribute('aria-current'),
    { timeout: 15_000, message: `点击「${title}」后该分区必须成为活动分区` },
  ).toBe('true')

  return item
}
