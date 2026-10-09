import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchDshBrowser, newDshPage } from '../support/browser'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

describe('built-in desktop appearance', () => {
  it.each([
    ['nord', '#eceff4', '#2e3440'],
    ['github', '#f0f6fc', '#1f2328'],
    ['github-dimmed', '#d1d7e0', '#1f2328'],
    ['github-high-contrast', '#ffffff', '#010409'],
  ])('renders %s tokens in the real core and restores its original colours', async (palette, darkText, lightText) => {
    const app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      const initial = await app.frame.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-label-primary'))
      await app.page.evaluate(palette => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette } }, location.origin), palette)
      await expect.poll(() => app.frame.locator('body').evaluate((el, [darkText, lightText]) => {
        const dark = el.hasAttribute('data-ds-dark-theme')
        return getComputedStyle(el).getPropertyValue('--dsw-alias-label-primary') === (dark ? darkText : lightText)
      }, [darkText, lightText]), { message: '配色必须通过真实主题服务应用到页面' }).toBe(true)
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: {} }, location.origin))
      await expect.poll(() => app.frame.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-label-primary')), { message: '重置必须恢复原有主题变量' }).toBe(initial)
      expect(app.errors, '外观切换不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('hides the sidebar in terminal mode and permits the existing desktop toggle to reveal it', async () => {
    const app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      const sidebar = app.frame.locator('[data-slot="sidebar"]')
      const originalFont = await app.frame.locator('body').evaluate(el => getComputedStyle(el).fontFamily)
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { terminal: true } }, location.origin))
      await expect.poll(() => sidebar.evaluate(el => el.parentElement!.getBoundingClientRect().width), { message: '终端模式下侧栏不应占用空白列' }).toBe(0)
      expect(await sidebar.evaluate(el => getComputedStyle(el).visibility), '隐藏侧栏内容不可见').toBe('hidden')
      expect(await app.frame.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).toBe(originalFont)
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://sidebar:toggle' }, location.origin))
      await expect.poll(() => sidebar.evaluate(el => el.parentElement!.getBoundingClientRect().width), { message: '原有侧栏开关必须能恢复侧栏' }).toBeGreaterThanOrEqual(264)
      expect(await sidebar.evaluate(el => getComputedStyle(el).visibility), '展开后侧栏内容可见').toBe('visible')
      expect(app.errors, '终端模式不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('keeps the session opaque while the sidebar is transparent and restores full-window transparency', async () => {
    const app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette: 'forest', transparency: true, opacity: 70, sidebarOnly: true } }, location.origin))
      const main = app.frame.locator('[data-slot="main"]')
      await expect.poll(() => main.evaluate(el => getComputedStyle(el.parentElement!).backgroundColor), { message: '会话区域必须有不透明背景' }).toMatch(/^rgb\(/)
      expect(await main.evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base'))).toMatch(/^#[\da-f]{6}$/i)
      expect(await app.frame.locator('[data-slot="sidebar"]').evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base'))).toBe('transparent')
      expect(await app.frame.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/(?:0\.7\)|\/ 0\.7\))/)
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette: 'forest', transparency: true, opacity: 70, sidebarOnly: false } }, location.origin))
      await expect.poll(() => main.evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base'))).toBe('transparent')
      expect(app.errors).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('applies alpha to the canvas without fading text or menu surfaces', async () => {
    const app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette: 'forest', opacity: 70 } }, location.origin))
      await expect.poll(() => app.frame.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), { message: '画布背景应保留 70% 不透明度' }).toMatch(/(?:0\.7\)|\/ 0\.7\))/)
      const surface = await app.frame.locator('body').evaluate((el) => {
        const css = getComputedStyle(el)
        return { opacity: css.opacity, menu: css.getPropertyValue('--dsw-specific-menu'), base: css.getPropertyValue('--dsw-alias-bg-base') }
      })
      expect(surface.opacity, '文字不得随背景整体淡化').toBe('1')
      expect(surface.menu, '菜单必须有不透明底色').toMatch(/^#[\da-f]{6}$/i)
      expect(surface.base, '嵌套画布不得叠加不透明背景').toBe('transparent')
      expect(app.errors, '透明模式不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('keeps the composer backing opaque when the conversation canvas is translucent', async () => {
    const app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      await app.page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette: 'nord', transparency: true, opacity: 70, sidebarOnly: false } }, location.origin))
      const composer = app.frame.locator('[data-composer-seat]').first()
      await expect.poll(() => composer.evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base')), { message: '固定输入区的渐变底色不能透出后方滚动的文字' }).toMatch(/^#(?:2e3440|eceff4)$/)
      expect(await app.frame.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base')), '会话画布仍保持透明').toBe('transparent')
      expect(app.errors).toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
