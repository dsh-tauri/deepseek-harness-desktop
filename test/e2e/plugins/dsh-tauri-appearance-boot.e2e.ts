import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appearanceBootCss, normalizeAppearance } from '../../../packages/dsh-tauri/src/shared/appearance'
import { launchDshBrowser } from '../support/browser'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

describe('appearance boot stylesheet handoff', () => {
  it.each(['dark', 'light'] as const)('paints one translucent layer during %s boot and releases the running page', async (scheme) => {
    const page = await browser.newPage()
    try {
      await page.setContent(`<html><body ${scheme === 'dark' ? 'data-ds-dark-theme' : ''}><div id="root"><div data-dsh-boot>Loading</div></div></body></html>`)
      await page.addStyleTag({ content: 'body{background:rgb(20,30,40)!important}#root{background:rgb(40,50,60)}' })
      await page.addStyleTag({ content: appearanceBootCss(normalizeAppearance({ palette: 'nord', transparency: true, opacity: 70 })) })
      const layers = await page.locator('html,body,#root,[data-dsh-boot]').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor))
      expect(layers.slice(0, 3), '启动背景不能叠加多层透明色').toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      expect(layers[3], '启动节点保留设置的透明度').toMatch(/(?:0\.7\)|\/ 0\.7\))/)
      await page.locator('#root').evaluate(el => el.replaceChildren(document.createElement('main')))
      expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), '启动样式不能覆盖运行页背景').toBe('rgb(20, 30, 40)')
      expect(await page.locator('#root').evaluate(el => getComputedStyle(el).backgroundColor), '启动样式不能覆盖运行页根节点').toBe('rgb(40, 50, 60)')
    }
    finally {
      await page.close()
    }
  })

  it('keeps one boot fill when the appearance plugin also paints the body', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<body><div id="root"><div data-dsh-boot>Loading</div></div></body>')
      const appearance = normalizeAppearance({ palette: 'nord', transparency: true, opacity: 70 })
      await page.addStyleTag({ content: appearanceBootCss(appearance) })
      await page.addStyleTag({ content: `html{background:transparent!important}body{background:rgba(46,52,64,.7)!important}${appearanceBootCss(appearance)}` })
      expect(await page.locator('[data-dsh-boot]').evaluate(el => getComputedStyle(el).backgroundColor), '插件接管后启动节点仍只绘制一层透明色').toMatch(/(?:0\.7\)|\/ 0\.7\))/)
      expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    }
    finally {
      await page.close()
    }
  })
})
