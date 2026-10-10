import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage } from '../support/browser'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

const DIALOG = '[role="dialog"][aria-modal="true"][data-dsh-mobile-settings]'
// Official current SettingsRoot uses settings.launcher; legacy puts settings.trigger inside its button.
const LAUNCHER = '[data-slot="settings.launcher"] button[aria-haspopup="dialog"], button[aria-haspopup="dialog"]:has([data-slot="settings.trigger"])'

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

describe('mobile settings official host composition', () => {
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
      await app.page.keyboard.press('Shift+Tab')
      await toggle.focus()
      expect(await toggle.evaluate(element => element.matches(':focus-visible')), '键盘导航仍须有可见焦点').toBe(true)
      expect(await toggle.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')

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
        await menu.getByRole('menuitem', { name: '中文', exact: true }).click()
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
