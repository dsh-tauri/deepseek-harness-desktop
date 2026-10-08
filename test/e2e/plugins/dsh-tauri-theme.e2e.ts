import type { Browser } from 'playwright'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage, openSettings } from '../support/browser'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

describe('desktop appearance theme switching', () => {
  it.each([false, true])('keeps the selected theme with transparency=%s', async (transparency) => {
    let app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
    try {
      await app.page.evaluate(transparency => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'dsh://appearance', appearance: { palette: 'nord', transparency, opacity: 70, sidebarOnly: true } }, location.origin), transparency)
      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      const buttons = app.frame.locator('[data-slot="settings.section"] button[aria-pressed]')
      expect(await buttons.allTextContents()).toHaveLength(3)
      const initialIndex = await buttons.evaluateAll(elements => elements.findIndex(el => el.getAttribute('aria-pressed') === 'true'))
      expect(initialIndex, '主题设置必须有当前选项').toBeGreaterThanOrEqual(0)
      for (const [index, scheme] of [[1, 'dark'], [0, 'light'], [1, 'dark']] as const) {
        await buttons.nth(index).click()
        await expect.poll(() => app.frame.locator('html').evaluate(el => (el as HTMLElement).style.colorScheme), { message: '主题选择必须切换实际页面配色' }).toBe(scheme)
        await expect.poll(() => buttons.nth(index).getAttribute('aria-pressed'), { message: '主题选择不得回跳' }).toBe('true')
        await expect.poll(() => readFile(join(inject('dshHome'), 'profiles/web/cordis.patch.yml'), 'utf8'), { timeout: 8000, message: '主题必须保存到隔离测试档案' }).toContain(`preference: ${scheme}`)
      }
      expectNoSyntheticFallbacks(app)
      expect(app.errors).toEqual([])
      await app.close()
      app = await newDshPage(browser, { ready: 'style[id="dsh-tauri:appearance"]' })
      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      expect(await app.frame.locator('html').evaluate(el => (el as HTMLElement).style.colorScheme), '重新打开页面必须保留深色主题').toBe('dark')
      expect(await app.frame.locator('[data-slot="settings.section"] button[aria-pressed]').nth(1).getAttribute('aria-pressed'), '重新打开页面必须保留选中态').toBe('true')
      await app.frame.locator('[data-slot="settings.section"] button[aria-pressed]').nth(initialIndex).click()
      await expect.poll(() => readFile(join(inject('dshHome'), 'profiles/web/cordis.patch.yml'), 'utf8'), { timeout: 8000, message: '测试结束后恢复原有主题偏好' }).toContain(`preference: ${['light', 'dark', 'system'][initialIndex]}`)
      expectNoSyntheticFallbacks(app)
      expect(app.errors).toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
