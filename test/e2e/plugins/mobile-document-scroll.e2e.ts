import type { Browser } from 'playwright'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import mobileStyle from '../../../packages/dsh-tauri-mobile-ui/src/client/styles/mobile.cssr'

vi.mock('../../../packages/dsh-tauri/dist/client.cjs', () => import('../../../packages/dsh-tauri/src/client/utils/device'))
vi.mock('../../../packages/dsh-tauri-ui/dist/client.cjs', () => import('../../../packages/dsh-tauri-ui/src/client/utils/cssr'))

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
const conversationPage = `<!doctype html><html data-dsh-mobile-sidebar><head>
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
  <div data-overflow-probe></div></body></html>`

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

it('contains synthetic document overflow during touch scrolling while preserving the internal scrollport', async () => {
  const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
  try {
    await page.setContent(conversationPage)
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

it.each([
  { layout: 'mobile', width: 390, height: 844, keyboardTop: 508 },
  { layout: 'desktop', width: 1180, height: 820, keyboardTop: 460 },
])('fits the $layout conversation shell into the keyboard-visible height published by the keyboard register', async ({ layout, width, height, keyboardTop }) => {
  const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width, height } })
  try {
    await page.setContent(conversationPage)
    if (layout === 'desktop') {
      await page.evaluate(() => {
        document.documentElement.removeAttribute('data-dsh-mobile-sidebar')
        document.querySelector('[data-dsh-mobile-navbar-host]')?.remove()
      })
    }
    await page.addStyleTag({ content: mobileStyle.render() })
    const composerBottom = () => page.locator('[data-composer-seat]').evaluate(element => element.getBoundingClientRect().bottom)
    await page.evaluate(top => document.documentElement.style.setProperty('--dsh-mobile-viewport-height', `${top}px`), keyboardTop)
    expect(await composerBottom(), '键盘弹出时输入区须贴住键盘上沿').toBe(keyboardTop)
    expect(await page.locator('[data-slot="root"]').evaluate(element => element.getBoundingClientRect().top), '页面顶端须留在可见区顶部').toBe(0)
    await page.evaluate(() => document.documentElement.style.removeProperty('--dsh-mobile-viewport-height'))
    expect(await composerBottom(), '键盘收起后输入区回到视口底部').toBe(height)
  }
  finally {
    await page.close()
  }
})

it('releases document scrolling when mobile sidebar ownership ends', async () => {
  const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
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

it('leaves document scrolling unchanged for desktop pointer media', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
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
