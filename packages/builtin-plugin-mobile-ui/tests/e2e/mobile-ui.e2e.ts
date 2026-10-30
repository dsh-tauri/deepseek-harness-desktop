import type { Browser } from 'playwright'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage } from '../../../../apps/desktop/tests/e2e/support/browser'
import mobileStyle from '../../src/client/styles/mobile.cssr'

vi.mock('dsh-tauri/client', () => import('../../../builtin-plugin-tauri/src/client/utils/device'))
vi.mock('dsh-tauri-ui/client', () => import('../../../builtin-plugin-ui/src/client/utils/cssr'))

const require = createRequire(import.meta.url)
const upstream = ['layout', 'conversation'].map((name) => {
  const source = readFileSync(require.resolve(`@deepseek-ai/dsh-client-ui-${name}/client`), 'utf8')
  const anchor = name === 'layout' ? 'const css = ' : 'const css$4 = '
  const start = source.indexOf(anchor)
  if (source.split(anchor).length !== 2)
    throw new Error(`Expected one upstream ${name} stylesheet`)
  const literal = source.slice(start + anchor.length).match(/^"(?:\\.|[^"\\])*"/)
  if (!literal)
    throw new Error(`Missing upstream ${name} CSS literal`)
  return JSON.parse(literal[0]) as string
}).join('\n')

let browser: Browser
let plainBrowser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
  plainBrowser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  await plainBrowser?.close()
})

const DIALOG = '[role="dialog"][aria-modal="true"][data-dsh-mobile-settings]'
const LAUNCHER = '[data-slot="settings.launcher"] button[aria-haspopup="dialog"]'

async function openPhoneSettings(width: number, height: number) {
  const app = await newDshPage(browser, {
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    ready: '[data-dsh-mobile-sidebar-toggle]',
  })
  try {
    const toggle = app.frame.locator('[data-dsh-mobile-sidebar-toggle]')
    const toggleBox = (await toggle.boundingBox())!
    expect(
      { width: Math.round(toggleBox.width), height: Math.round(toggleBox.height) },
      '移动侧边栏图标必须按 20px 渲染，而不是回落到字形尺寸或旧的 24px',
    ).toEqual({ width: 20, height: 20 })
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded'), { message: '真实移动入口必须展开侧栏' }).toBe('true')
    const launcher = app.frame.locator(LAUNCHER)
    expect(await launcher.count(), '官方设置入口必须唯一').toBe(1)
    await launcher.click()
    const dialog = app.frame.locator(DIALOG)
    await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view'), { message: '官方入口必须先显示设置分类而非当前分区' }).toBe('menu')
    return { app, dialog }
  }
  catch (error) {
    await app.close()
    throw error
  }
}

describe('mobile-ui official host composition', () => {
  it('animates real touch toggles without tap outlines and honors reduced motion', async () => {
    const app = await newDshPage(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      ready: '[data-dsh-mobile-sidebar-toggle]',
    })
    try {
      await app.page.emulateMedia({ reducedMotion: 'no-preference' })
      const toggle = app.frame.locator('[data-dsh-mobile-sidebar-toggle]')
      const plus = app.frame.locator('[data-dsh-mobile-new-session]')
      const center = app.frame.locator('[class$="_centerCol"]')
      const shade = app.frame.locator('[data-dsh-mobile-sidebar-shade]')
      await app.frame.locator('[class$="_centerCol"], [data-dsh-mobile-sidebar-shade]').evaluateAll((elements) => {
        for (const element of elements) {
          element.setAttribute('data-e2e-transform-count', '0')
          element.addEventListener('transitionrun', (event) => {
            if (event.target === element && (event as TransitionEvent).propertyName === 'transform')
              element.setAttribute('data-e2e-transform-count', String(Number(element.getAttribute('data-e2e-transform-count')) + 1))
          })
        }
      })
      await toggle.tap()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '点击展开必须真正启动主面板位移动效' }).toBe('1')
      await expect.poll(() => shade.getAttribute('data-e2e-transform-count'), { message: '遮罩必须跟随主面板过渡' }).toBe('1')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(319)
      await shade.tap()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '点击关闭也必须保留位移动效' }).toBe('2')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(0)
      expect(await toggle.evaluate(element => ({
        outline: getComputedStyle(element).outlineStyle,
        tap: getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color'),
        keyboardFocus: element.matches(':focus-visible'),
      })), '触摸后恢复焦点不能留下浏览器默认框').toEqual({ outline: 'none', tap: 'rgba(0, 0, 0, 0)', keyboardFocus: false })
      await plus.tap()
      expect(await plus.evaluate(element => getComputedStyle(element).outlineStyle), '新会话图标触摸后也不能留下默认框').toBe('none')
      await expect.poll(() => app.frame.locator('[data-conversation-scroll]').count(), { message: '新会话必须先挂载会话区', timeout: 15_000 }).toBe(1)
      for (let index = 0; index < 10 && !await toggle.evaluate(element => document.activeElement === element); index++)
        await app.page.keyboard.press('Shift+Tab')
      expect(await toggle.evaluate(element => ({
        active: document.activeElement === element,
        focusVisible: element.matches(':focus-visible'),
        outline: getComputedStyle(element).outlineStyle,
      })), '键盘导航仍须有可见焦点').toEqual({ active: true, focusVisible: true, outline: 'solid' })

      await app.page.emulateMedia({ reducedMotion: 'reduce' })
      await toggle.tap()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      expect(Math.round((await center.boundingBox())!.x), '减少动态效果时应直接到达展开位置').toBe(319)
      expect(await center.getAttribute('data-e2e-transform-count'), '系统减少动态效果时不得强行动画').toBe('2')
      await shade.tap()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      expect(Math.round((await center.boundingBox())!.x)).toBe(0)
      expectNoSyntheticFallbacks(app)
      expect(app.errors).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('settles real conversation swipes with transitions and keeps subsequent tap animations', async () => {
    const app = await newDshPage(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      ready: '[data-dsh-mobile-sidebar-toggle]',
    })
    try {
      await app.page.emulateMedia({ reducedMotion: 'no-preference' })
      await app.frame.locator('[data-dsh-mobile-new-session]').tap()
      await expect.poll(() => app.frame.locator('[data-conversation-scroll]').count(), { message: '必须在真实会话区验证手势，而非插件面板' }).toBe(1)
      await expect.poll(
        () => app.frame.evaluate(async () => {
          const target = document.elementFromPoint(80, 220)
          if (!target?.closest('[data-conversation-scroll]'))
            return false
          for (let frame = 0; frame < 3; frame++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
            if (!target.isConnected || document.elementFromPoint(80, 220) !== target)
              return false
          }
          return true
        }),
        { message: '真实会话内的手势落点必须跨渲染帧保持同一已连接节点' },
      ).toBe(true)
      const center = app.frame.locator('[class$="_centerCol"]')
      const toggle = app.frame.locator('[data-dsh-mobile-sidebar-toggle]')
      const shade = app.frame.locator('[data-dsh-mobile-sidebar-shade]')
      await center.evaluate((element) => {
        element.setAttribute('data-e2e-transform-count', '0')
        element.addEventListener('transitionrun', (event) => {
          if (event.target === element && (event as TransitionEvent).propertyName === 'transform')
            element.setAttribute('data-e2e-transform-count', String(Number(element.getAttribute('data-e2e-transform-count')) + 1))
        })
      })
      const cdp = await app.page.context().newCDPSession(app.page)
      const swipe = async (start: number, end: number) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y: 220 }] })
        for (let step = 1; step <= 4; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * step / 4, y: 220 }] })
        }
        expect(await app.frame.locator('html').getAttribute('data-dsh-mobile-sidebar-dragging'), '横向会话手势必须接管拖动').toBe('')
        expect(await center.evaluate(element => getComputedStyle(element).transitionDuration), '跟手阶段不应滞后动画').toBe('0s')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        expect(await app.frame.locator('html').getAttribute('data-dsh-mobile-sidebar-dragging'), '松手必须立即清理禁用过渡状态').toBeNull()
      }
      await swipe(80, 280)
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '会话区松手展开必须真正启动过渡' }).toBe('1')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(319)
      await swipe(370, 180)
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '松手收起必须真正启动过渡' }).toBe('2')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(0)
      await toggle.tap()
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '拖动后点击展开不能丢失动画' }).toBe('3')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(319)
      await shade.tap()
      await expect.poll(() => center.getAttribute('data-e2e-transform-count'), { message: '拖动后点击收起不能丢失动画' }).toBe('4')
      await expect.poll(async () => Math.round((await center.boundingBox())!.x)).toBe(0)
      await cdp.detach()
      expectNoSyntheticFallbacks(app)
      expect(app.errors).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it.each([{ width: 320, height: 568 }, { width: 430, height: 943 }, { width: 767, height: 800 }])('keeps the official section mounted through categories at $width pixels', async ({ width, height }) => {
    const { app, dialog } = await openPhoneSettings(width, height)
    try {
      const list = dialog.locator('[data-dsh-mobile-settings-list]')
      const options = dialog.locator('[data-dsh-mobile-settings-options]')
      const controls = dialog.locator('[data-dsh-mobile-settings-controls]')
      const close = dialog.locator('[data-dsh-mobile-settings-close]')
      const current = list.locator('button[aria-current="true"]')
      expect(await current.count(), '原生分区选中态必须唯一').toBe(1)
      const label = (await current.textContent())!.trim()
      expect(label, '原生当前分区必须提供可访问标题').not.toBe('')
      expect(await dialog.evaluate(el => document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent?.trim()), '保留官方对话框可访问名称').toBe('设置')
      expect(await options.evaluate(el => ({ hidden: el.hasAttribute('hidden'), inert: el.hasAttribute('inert') })), '分类页必须使原生详情不可聚焦').toEqual({ hidden: true, inert: true })
      expect(await controls.isVisible(), '分类页不显示详情返回按钮').toBe(false)
      expect(await app.page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        x: window.scrollX,
        y: window.scrollY,
      })), '嵌入驱动不能产生基线空隙或父页滚动来偏移原生全屏对话框').toEqual({ width, height, x: 0, y: 0 })
      expect(await app.page.locator('#dsh').boundingBox(), '被测 iframe 必须与手机视口原点及尺寸对齐').toEqual({ x: 0, y: 0, width, height })
      const menuBox = await dialog.boundingBox()
      expect(menuBox, '分类页必须有真实手机全屏几何').not.toBeNull()
      expect(menuBox!.x).toBeCloseTo(0)
      expect(menuBox!.y).toBeCloseTo(0)
      expect(menuBox!.width).toBeCloseTo(width)
      expect(menuBox!.height).toBeCloseTo(height)
      expect((await current.boundingBox())!.height, '原生分类项必须提供至少 52px 触摸目标').toBeGreaterThanOrEqual(52)

      await current.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view'), { message: '原生当前分类再次点击也必须进入详情' }).toBe('detail')
      const back = dialog.getByRole('button', { name: '返回设置分类', exact: true })
      expect(await list.evaluate(el => ({ hidden: el.hasAttribute('hidden'), inert: el.hasAttribute('inert') })), '详情页必须使原生分类不可聚焦').toEqual({ hidden: true, inert: true })
      expect(await options.isVisible(), '进入详情必须显示真正的原生分区').toBe(true)
      expect(await dialog.locator('[data-dsh-mobile-settings-section-title]').textContent(), '详情标题必须对应原生分区选中态').toBe(label)
      const section = await dialog.locator('[data-slot="settings.section"]').elementHandle()
      expect(section, '详情必须挂载官方 settings.section 座位').not.toBeNull()
      const backBox = (await back.boundingBox())!
      const closeBox = (await close.boundingBox())!
      expect(backBox.width, '返回必须保持 40px 命中目标').toBe(40)
      expect(closeBox.width, '官方关闭必须保持 40px 命中目标').toBe(40)
      expect(closeBox.x, '关闭不能压在返回按钮之上').toBeGreaterThan(backBox.x + backBox.width)
      expect((await options.boundingBox())!.y, '详情内容必须排在工具栏下方').toBeGreaterThanOrEqual(backBox.y + backBox.height)
      const actions = dialog.locator('[data-dsh-mobile-settings-actions] button:not([data-dsh-mobile-settings-back])')
      for (let index = 0; index < await actions.count(); index++) {
        const action = actions.nth(index)
        if (await action.isVisible()) {
          expect((await action.boundingBox())!.y, '原生操作必须排在移动工具栏下方而非与返回重叠').toBeGreaterThanOrEqual(backBox.y + backBox.height)
        }
      }

      await back.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view'), { message: '返回只改分类展示，不关闭或重建原生分区' }).toBe('menu')
      expect(await section!.evaluate(el => el.isConnected), '返回分类必须保留同一个官方分区节点').toBe(true)
      expect(await current.getAttribute('aria-current'), '返回不能修改原生分区选中态').toBe('true')
      expect(await current.evaluate(el => document.activeElement === el), '返回必须把焦点交给可见原生分类').toBe(true)
      await current.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
      expect(await section!.evaluate(el => el === document.querySelector('[data-slot="settings.section"]')), '重新进入必须复用分区而非卸载重建').toBe(true)
      await close.click()
      await expect.poll(() => dialog.count(), { message: '官方关闭仍必须真正退出设置对话框' }).toBe(0)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '分类/详情切换不得产生浏览器应用错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('retains an unsaved provider credential through Back and native re-selection', async () => {
    const { app, dialog } = await openPhoneSettings(430, 943)
    try {
      const models = dialog.locator('[data-dsh-mobile-settings-list]').getByRole('button', { name: '模型', exact: true })
      await models.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
      await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
      const catalog = dialog.locator('[data-slot="settings.section"] [id$="-catalog-panel"]')
      expect(await catalog.count(), '添加目录编辑器必须唯一，不得误选原生 setup 编辑器').toBe(1)
      expect(await catalog.isVisible(), '未提交凭据必须输入实际显示的添加目录编辑器').toBe(true)
      const credential = catalog.getByLabel('API 密钥', { exact: true })
      await credential.fill('mobile-unsaved-credential')
      const input = await credential.elementHandle()
      expect(input, '真实提供商编辑器必须有未提交草稿输入').not.toBeNull()
      await dialog.getByRole('button', { name: '返回设置分类', exact: true }).click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('menu')
      expect(await input!.evaluate(el => ({ connected: el.isConnected, value: (el as HTMLInputElement).value })), '返回分类不得丢失未提交凭据').toEqual({ connected: true, value: 'mobile-unsaved-credential' })
      await models.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
      expect(await credential.inputValue(), '再次选择同一原生分类必须保留草稿').toBe('mobile-unsaved-credential')
      expect(await credential.evaluate((el, original) => el === original, input!), '再次进入必须保留同一个添加编辑器输入节点').toBe(true)
      expect(await dialog.locator('[data-dsh-mobile-settings-section-title]').textContent()).toBe('模型')
      await app.page.keyboard.press('Escape')
      await expect.poll(() => dialog.count(), { message: '原生 Escape 仍必须关闭完整对话框' }).toBe(0)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '未提交编辑器切换不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('updates native and additive labels when the real locale changes', async () => {
    const { app, dialog } = await openPhoneSettings(430, 943)
    const current = dialog.locator('[data-dsh-mobile-settings-list] button[aria-current="true"]')
    const language = dialog.locator('[data-slot="settings.general.item"]')
    const menu = app.frame.getByRole('menu')
    try {
      await current.click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
      await expect.poll(() => dialog.locator('[data-dsh-mobile-settings-section-title]').textContent(), { message: '详情必须落到通用设置' }).toBe('通用设置')
      await language.getByRole('button', { name: '中文', exact: true }).click()
      await menu.getByRole('menuitem', { name: 'English', exact: true }).click()
      await expect.poll(() => dialog.getByRole('button', { name: 'Back to settings categories', exact: true }).count(), { message: '真实 locale 变更必须更新附加返回按钮' }).toBe(1)
      await expect.poll(() => dialog.locator('[data-dsh-mobile-settings-section-title]').textContent(), { message: '标题必须跟随原生 locale 分区名' }).toBe('General')
      expect(await dialog.evaluate(el => document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent?.trim()), '原生对话框名称也必须切换语言').toBe('Settings')
      await dialog.getByRole('button', { name: 'Back to settings categories', exact: true }).click()
      await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('menu')
      expect(await current.textContent(), '原生分类不能留下旧语言副本').toBe('General')
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '真实 locale 切换不得产生浏览器错误').toEqual([])
    }
    finally {
      try {
        if (await menu.isVisible())
          await app.page.keyboard.press('Escape')
        if (await dialog.getAttribute('data-dsh-mobile-settings-view') === 'menu') {
          await current.click()
          await expect.poll(() => dialog.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
        }
        await language.getByRole('button', { name: /^(?:中文|English)$/ }).click()
        const [persistedLocale] = await Promise.all([
          app.page.waitForResponse(async (response) => {
            if (!response.url().endsWith('/api/settings/mutate'))
              return false
            const body = await response.json()
            return body.result?.value?.ns === 'locale' && body.result.value.user?.preference === 'zh'
          }),
          menu.getByRole('menuitem', { name: '中文', exact: true }).click(),
        ])
        expect(await persistedLocale.json(), '关闭页面前必须确认宿主已接受中文写入，而非仅完成乐观 UI 更新').toMatchObject({ result: { ok: true, value: { ns: 'locale', user: { preference: 'zh' } } } })
        await expect.poll(() => language.getByRole('button', { name: '中文', exact: true }).count(), { message: '共享宿主语言偏好必须原生恢复，不能污染后续 shuffle 用例' }).toBe(1)
        await expect.poll(() => dialog.evaluate(el => document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent?.trim())).toBe('设置')
        await dialog.locator('[data-dsh-mobile-settings-close]').click()
        await expect.poll(() => dialog.count()).toBe(0)
        expectNoSyntheticFallbacks(app)
        expect(app.errors, '恢复共享语言偏好不得产生浏览器错误').toEqual([])
      }
      finally {
        await app.close()
      }
    }
  })
})

it('contains synthetic document overflow during touch scrolling while preserving the internal scrollport', async () => {
  const page = await plainBrowser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
  try {
    await page.setContent(`<!doctype html><html data-dsh-mobile-sidebar><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>html,body,#root,[data-slot="root"]{height:100%;margin:0}
      ${upstream}
      [data-slot="main"]{height:100%} nav{height:52px;flex-shrink:0}
      article{height:2400px;flex-shrink:0}[data-composer-seat]{height:120px}
      [data-overflow-probe]{height:640px}</style></head><body>
      <div id="root"><div data-slot="root"><div class="pI_x6G_frame">
        <div class="pI_x6G_centerCol"><div data-dsh-mobile-navbar-host><nav>Navigation</nav></div>
          <div data-slot="main"><div class="wSkVaW_root" data-phase="active"><div class="wSkVaW_body">
            <div class="wSkVaW_scrollBody" data-conversation-scroll><article>Messages</article>
              <div class="wSkVaW_composerSeat" data-composer-seat><textarea aria-label="Draft"></textarea></div>
            </div></div></div></div></div><div data-shell-overlay></div></div></div></div>
      <div data-overflow-probe></div></body></html>`)
    await page.addStyleTag({ content: mobileStyle.render() })
    const scroll = page.locator('[data-conversation-scroll]')
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const cdp = await page.context().newCDPSession(page)
    const swipe = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 600 }] })
      for (let step = 1; step <= 8; step++)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 600 - step * 45 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await swipe()
    expect(await page.evaluate(() => window.scrollY), '消息触底后继续上滑不得滚动文档，即使文档出现额外溢出').toBe(0)
    expect(await page.locator('[data-composer-seat]').evaluate(element => element.getBoundingClientRect().bottom), '输入区仍须贴住视口底部').toBe(844)
    expect(await page.locator('textarea').evaluate(element => document.activeElement === element), '回归路径不得依赖输入聚焦或键盘').toBe(false)
    await scroll.evaluate((element) => {
      element.scrollTop = 0
    })
    await swipe()
    await expect.poll(() => scroll.evaluate(element => element.scrollTop), { message: '文档锁定后内部消息仍须能响应真实触摸滚动' }).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY), '内部滚动不得移动文档').toBe(0)
    await cdp.detach()
  }
  finally {
    await page.close()
  }
})

it('releases document scrolling when mobile sidebar ownership ends', async () => {
  const page = await plainBrowser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
  try {
    await page.setContent('<!doctype html><html data-dsh-mobile-sidebar><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="height:1800px"></body></html>')
    await page.addStyleTag({ content: mobileStyle.render() })
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), '移动所有权存在时文档须锁定').toBe('hidden')
    await page.evaluate(() => document.documentElement.removeAttribute('data-dsh-mobile-sidebar'))
    await page.mouse.move(200, 200)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: '退出移动布局所有权后不得留下全局文档锁' }).toBeGreaterThan(0)
  }
  finally {
    await page.close()
  }
})

it('pins the page to the keyboard height reported while composing in the desktop layout', async () => {
  const page = await plainBrowser.newPage({ hasTouch: true, viewport: { width: 1180, height: 820 } })
  try {
    await page.setContent(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>html,body,#root{height:100%;margin:0}
      #root{display:flex;flex-direction:column}
      [data-conversation-scroll]{flex:1;min-height:0;overflow:auto}
      article{height:2400px}
      [data-composer-seat]{flex-shrink:0;height:120px}</style></head><body>
      <div id="root">
        <div data-conversation-scroll><article>Messages</article></div>
        <div data-composer-seat><textarea aria-label="Draft"></textarea></div>
      </div>
    </body></html>`)
    await page.addStyleTag({ content: mobileStyle.render() })
    const seat = page.locator('[data-composer-seat]')
    const seatBottom = () => seat.evaluate(element => Math.round(element.getBoundingClientRect().bottom))
    expect(await seatBottom(), '无键盘时输入区贴在视口底部').toBe(820)
    await page.evaluate(() => document.documentElement.style.setProperty('--dsh-mobile-viewport-height', '520px'))
    expect(await page.evaluate(() => Math.round(document.documentElement.getBoundingClientRect().height)), 'iPad 横屏的桌面布局也须按键盘高度收缩').toBe(520)
    expect(await seatBottom(), '键盘弹出后输入区须守在键盘上沿').toBe(520)
    await page.evaluate(() => document.documentElement.style.removeProperty('--dsh-mobile-viewport-height'))
    expect(await seatBottom(), '键盘收起后输入区须回到视口底部').toBe(820)
  }
  finally {
    await page.close()
  }
})

it('leaves document scrolling unchanged for desktop pointer media', async () => {
  const page = await plainBrowser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await page.setContent('<!doctype html><html data-dsh-mobile-sidebar><body style="height:1800px"></body></html>')
    await page.addStyleTag({ content: mobileStyle.render() })
    await page.mouse.move(200, 200)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: '桌面鼠标媒体条件下不得锁定文档' }).toBeGreaterThan(0)
  }
  finally {
    await page.close()
  }
})

const MOBILE_MEDIA = '(hover: none) and (any-pointer: coarse) and (any-hover: none) and (max-width: 1023px)'
const HIDDEN = [
  '[data-slot="conversation.header"] [class$="_header"]',
  '[data-slot="conversation.composer.bar"] [class$="_dock"]',
  '[class$="_composerStack"] > [data-slot="conversation.input.dock"]',
]
const MARKUP = `<!doctype html><html data-dsh-mobile-ui><body>
  <div data-slot="conversation.session.header"><div data-slot="conversation.header"><header class="wSkVaW_header">Session title</header></div></div>
  <div data-slot="conversation.composer.bar"><div class="wSkVaW_dock">Queued messages</div></div>
  <div class="wSkVaW_composerStack"><div data-slot="conversation.input.dock"><div class="wSkVaW_dock">Steer panel</div></div></div>
</body></html>`
const INSPECT_MARKUP = `<!doctype html><html data-dsh-mobile-ui><body>
  <button type="button" class="wSkVaW_inspectButton">查看</button>
</body></html>`

async function layout(viewport: { width: number, height: number }) {
  const page = await plainBrowser.newPage({ isMobile: true, hasTouch: true, viewport })
  try {
    await page.setContent(MARKUP)
    await page.addStyleTag({ content: mobileStyle.render() })
    return {
      matches: await page.evaluate(media => matchMedia(media).matches, MOBILE_MEDIA),
      displays: await Promise.all(HIDDEN.map(selector => page.locator(selector).evaluate(element => getComputedStyle(element).display))),
    }
  }
  finally {
    await page.close()
  }
}

async function inspectDisplay(viewport: { width: number, height: number }) {
  const page = await plainBrowser.newPage({ isMobile: true, hasTouch: true, viewport })
  try {
    await page.setContent(INSPECT_MARKUP)
    await page.addStyleTag({ content: mobileStyle.render() })
    return await page.locator('[class$="_inspectButton"]').evaluate(element => getComputedStyle(element).display)
  }
  finally {
    await page.close()
  }
}

describe('mobile layout on touch devices', () => {
  it('keeps the session header, queue dock and steer dock on a touchscreen desktop window', async () => {
    const { matches, displays } = await layout({ width: 1280, height: 720 })

    expect(matches, '1280px 触屏窗口不得命中移动布局').toBe(false)
    expect(displays, '触屏桌面窗口不得隐藏会话头、排队插话面板与状态条').toEqual(['block', 'block', 'block'])
  })

  it('still hides them on a phone viewport', async () => {
    const { matches, displays } = await layout({ width: 390, height: 844 })

    expect(matches, '手机视口必须继续命中移动布局').toBe(true)
    expect(displays, '手机仍由顶栏与抽屉接管，三条桌面入口保持隐藏').toEqual(['none', 'none', 'none'])
  })

  it('switches exactly at the 1024px breakpoint of the official layout', async () => {
    expect((await layout({ width: 1024, height: 720 })).matches, '1024px 与官方布局同门槛，交还桌面').toBe(false)
    expect((await layout({ width: 1023, height: 720 })).matches, '1023px 仍是移动布局').toBe(true)
  })

  it('hides the tool-row inspect pill only on a phone viewport', async () => {
    expect(await inspectDisplay({ width: 1280, height: 720 }), '触屏桌面窗口保留官方「查看」').not.toBe('none')
    expect(await inspectDisplay({ width: 390, height: 844 }), '手机进得了轨迹页却回不了会话，入口必须隐藏').toBe('none')
  })
})
