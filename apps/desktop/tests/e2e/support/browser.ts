import type { Browser, BrowserContext, ElementHandle, Frame, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, inject } from 'vitest'

export const EMBEDDED_DOCUMENT_PATH = '/dsh-e2e-embed.html'

export const APP_FRAME_VIEWPORT = { width: 1400, height: 900 } as const

export const APP_LOCALE = 'zh-CN'

export const IGNORED_APP_ERRORS: readonly string[] = [
  'NODE_NOT_ANSWERED: invoke ',
]

export const SCHEDULER_ICON = '[data-dsh-scheduler-icon]'
export const WORKTREE_ICON = '[data-dsh-worktree-icon]'
export const WORKTREE_MODE_ANCHOR = '[data-dsh-tauri-worktree-mode-anchor]'
export const WORKTREE_SURFACE = '[data-dsh-worktree-surface]'
export const SESSION_ARCHIVE_ITEM = '[data-dsh-tauri-session-archive-item]'
export const SESSION_ARCHIVE_MENU_PATCHED = '[data-dsh-tauri-session-archive-menu-patched="1"]'
export const RUNNING_CHANGES = '[data-running-changes]'

export const PET_MENU_ITEM = '[data-dsh-tauri-pet-menu-item="1"]'
export const PET_MENU_PATCHED = '[data-dsh-tauri-pet-menu-patched="1"]'

export const SIDEBAR = '[data-slot="sidebar"]'
export const SIDEBAR_PANELLIST = '[data-slot="sidebar.panellist"]'
export const SETTINGS_TRIGGER = '[data-settings-trigger], [data-slot="settings.launcher"] button[aria-haspopup]'
export const SETTINGS_SIDEBAR = '[data-slot-sidebar="dsh-tauri-ui"]'
export const SETTINGS_SECTION_SLOT = '[data-slot="settings.section"]'
export const SETTINGS_NAV_ITEM = 'nav[aria-label] button'
export const SETTINGS_MENU_ITEM = '[role="menuitem"]'
export const SETTINGS_MENU_LABEL = /^(设置|Settings)/
export const SETTINGS_CONTENT = '[data-slot="settings.content"]'
export const SETTINGS_ONBOARDING = '[data-slot="settings.onboarding"]'
export const COMPOSER_CARD = '[data-composer-card]'
export const COMPOSER_INPUT_DOCK = '[data-slot="conversation.input.dock"]'
export const CONVERSATION_SESSION = '[data-slot="conversation.session"]'
export const SIDEBAR_ROW = 'button[class*="panelRow"]'

export const APP_MODAL = '[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="settings"])'
export const APP_MODAL_CANCEL = 'div[class*="_editorActions"] > button'

export interface DshPage {
  browser: Browser
  context: BrowserContext
  page: Page
  frame: Frame
  errors: string[]
  syntheticFallbacks: SyntheticFallback[]
  close: () => Promise<void>
}

export interface SyntheticFallback {
  site: string
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

export interface AppDiagnostics {
  errors: string[]
  ignored: string[]
  httpErrors: string[]
  requestFailures: string[]
}

const DIAGNOSTIC_LIMIT = 40
const diagnosticsByPage = new WeakMap<Page, AppDiagnostics>()

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

export function collectAppErrors(page: Page): string[] {
  return pageDiagnostics(page).errors
}

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
const INITIAL_MODAL_DISCOVERY_MS = 3_000

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

async function failWithDiagnostics(page: Page, frame: Frame, reason: string, cause: unknown): Promise<never> {
  const report = await describePageState(page, frame)
  throw new Error(
    `${reason}：${(cause as Error).message.split('\n')[0]}\n--- 失败现场 ---\n${report}`,
    { cause },
  )
}

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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

async function dispatchSyntheticClick(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

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
      discoveryDeadline = Math.min(deadline, Date.now() + discoveryMs)
      continue
    }
    await delay(300)
    if (await dismissOneModal(page, frame, fallbacks)) {
      discoveryDeadline = Math.min(deadline, Date.now() + discoveryMs)
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

const API_KEY_ENTRY = /^(添加 API Key|Add API Key)$/

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
      const apiKeyEntry = frame.locator(APP_MODAL).first().getByRole('button', { name: API_KEY_ENTRY })
      if (await apiKeyEntry.count() > 0) {
        await clickInFrame(page, apiKeyEntry.first(), fallbacks)
        continue
      }
      await dismissOneModal(page, frame, fallbacks)
    }
    else {
      await delay(300)
    }
  }
  const report = await describePageState(page, frame)
  const dialogs = await frame.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"]')).map(dialog => ({
      ariaModal: dialog.getAttribute('aria-modal'),
      inputs: dialog.querySelectorAll('input,textarea').length,
      text: (dialog.textContent ?? '').trim().slice(0, 160),
    }))).catch(error => [`DIALOG_DUMP_FAILED ${(error as Error).message}`])
  throw new Error(
    `等待带凭据输入的 API Key 引导弹层超时（${timeoutMs}ms）\n`
    + `--- 弹层现场 ---\ndialogs=${JSON.stringify(dialogs)}\n--- 失败现场 ---\n${report}`,
  )
}

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

export async function openSettings(
  page: Page,
  frame: Frame,
  fallbacks?: SyntheticFallback[],
): Promise<Locator> {
  const trigger = await openSettingsMenu(page, frame, fallbacks)

  if (await frame.locator(SETTINGS_SECTION_SLOT).count() === 0) {
    const settingsItem = frame.locator(SETTINGS_MENU_ITEM).filter({ hasText: SETTINGS_MENU_LABEL }).first()
    if (await settingsItem.count() > 0)
      await settingsItem.click()
  }

  await frame.locator(SETTINGS_SECTION_SLOT).first().waitFor({ state: 'attached', timeout: 15_000 })
  return trigger
}

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
