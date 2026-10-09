import type { Browser, BrowserContext, Page } from 'playwright'
import type { SyntheticFallback } from '../support/browser'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appUrl, dismissAppModals, launchDshBrowser, newDshPage, selectSettingsSection } from '../support/browser'

const SETTINGS = `<section role="dialog" aria-modal="true" data-shortcut-modal="settings" data-slot-sidebar="dsh-tauri-ui">
  <button onclick="this.closest('section').remove()">关闭设置</button>
  <input aria-label="搜索设置" value="kept-query">
  <nav aria-label="设置分区">
    <button aria-current="false" onclick="this.setAttribute('aria-current', 'true')">模型</button>
  </nav>
</section>`
const ONBOARDING = `<section role="dialog" aria-modal="true">
  <div class="fixture_editorActions">
    <button onclick="this.closest('section').remove()">稍后配置</button>
  </div>
</section>`

let browser: Browser
let context: BrowserContext
let page: Page

beforeAll(async () => {
  browser = await launchDshBrowser()
})

beforeEach(async () => {
  context = await browser.newContext()
  page = await context.newPage()
})

afterEach(async () => {
  await context.close()
})

afterAll(async () => {
  await browser.close()
})

describe('浏览器编排：阻塞引导弹窗', () => {
  it('关闭阻塞弹窗时保留已打开的设置页', async () => {
    await page.setContent(SETTINGS)
    const fallbacks: SyntheticFallback[] = []

    await dismissAppModals(page, page.mainFrame(), fallbacks)

    expect(await page.locator('[data-slot-sidebar="dsh-tauri-ui"]').count(), '设置页不是需要自动关闭的引导弹窗').toBe(1)
    expect(await page.getByRole('textbox', { name: '搜索设置' }).inputValue(), '弹窗闸不得重建或清空已打开的设置页').toBe('kept-query')
    expect(fallbacks, '弹窗闸不得合成点击设置页').toEqual([])
  })

  it('iframe 内设置页与引导弹窗共存时只关闭引导并允许选择分区', async () => {
    await page.setContent('<iframe style="width:100%;height:600px"></iframe>')
    const frame = page.frames().find(candidate => candidate.parentFrame() === page.mainFrame())
    if (!frame)
      throw new Error('夹具的应用 iframe 未挂载')
    await frame.setContent(SETTINGS + ONBOARDING)
    const fallbacks: SyntheticFallback[] = []

    await dismissAppModals(page, frame, fallbacks)

    expect(await frame.locator('[data-slot-sidebar="dsh-tauri-ui"]').count(), '关闭引导时必须保留设置侧栏').toBe(1)
    expect(await frame.locator('[role="dialog"]:not([data-slot-sidebar])').count(), '真正的阻塞引导必须被关闭').toBe(0)
    const section = await selectSettingsSection(page, frame, '模型', fallbacks)
    expect(await section.getAttribute('aria-current'), '经过可重入弹窗闸后仍必须能用真实指针选择模型分区').toBe('true')
    expect(fallbacks, '关闭引导与选择分区都不得依赖合成点击').toEqual([])
  })

  it('没有设置页时仍逐个关闭阻塞引导弹窗', async () => {
    await page.setContent(ONBOARDING + ONBOARDING)
    const fallbacks: SyntheticFallback[] = []

    await dismissAppModals(page, page.mainFrame(), fallbacks)

    expect(await page.getByRole('dialog').count(), '所有阻塞引导必须被关闭，不得因设置页保护而漏关').toBe(0)
    expect(fallbacks, '引导关闭必须走真实指针事件').toEqual([])
  })

  it('首次启动时等待并关闭晚于 ready 锚点挂载的引导弹窗', async () => {
    await context.route(appUrl('/'), route => route.fulfill({
      contentType: 'text/html',
      body: `<main data-slot="sidebar">ready</main><script>
        setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(ONBOARDING)}), 600)
        setTimeout(() => document.body.dataset.lateModalWindow = 'elapsed', 1_300)
      </script>`,
    }))

    const preparedBrowser = new Proxy(browser, {
      get(target, property, receiver) {
        if (property === 'newContext')
          return async () => context
        return Reflect.get(target, property, receiver)
      },
    })
    const app = await newDshPage(preparedBrowser)
    await app.frame.locator('body[data-late-modal-window="elapsed"]').waitFor({ state: 'attached' })

    expect(await app.frame.getByRole('dialog').count(), '真实启动入口必须关闭发现窗口内晚挂载的引导').toBe(0)
    expect(app.syntheticFallbacks, '晚挂载引导仍必须走真实指针事件').toEqual([])
  })
})
