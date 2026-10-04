import type { DesktopApp } from '../support/desktop'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startDesktopApp } from '../support/desktop'
import { completePreinstall } from '../support/preinstall'
import { PROXY_SAVE, PROXY_URL, SETUP_ERROR, SHELL_IFRAME, SHELL_ROOT } from '../support/selectors'

/** 全局 Window 类型扩展，用于解决浏览器环境上下文注入报错 */
interface DshWindow extends Window {
  __dshE2eErrors?: string[]
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string) => Promise<{ service_url: string, node_version: string }>
  }
}

/** 冷装配（真的联网下载 Node + dsh）的等待上限。 */
const ASSEMBLY_TIMEOUT_MS = 900_000

/** dsh 页面挂载点（`dsh-web-frontend/dist/index.html` 的 `<div id="root">`）。 */
const DSH_ROOT = '#root'

/** 页面渲染后留给插件异步加载收敛的观察窗口。 */
const SETTLE_MS = 3_000

/**
 * 在页面（壳层或帧内）安装报错收集器：三类页面级错误收进 `window.__dshE2eErrors`。
 * 只装一次；`console.error` 保留原实现，收集不改变页面行为。
 */
function collectPageErrors(): void {
  const host = window as DshWindow
  if (host.__dshE2eErrors)
    return

  const errors: string[] = []
  host.__dshE2eErrors = errors

  window.addEventListener('error', event => errors.push(`error: ${event.message}`))
  window.addEventListener('unhandledrejection', event => errors.push(`unhandledrejection: ${String(event.reason)}`))

  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    errors.push(`console.error: ${args.map(String).join(' ')}`)
    originalError(...args)
  }
}

/** 读回当前上下文的报错收集器；收集器不存在时返回空数组。 */
function readPageErrors(): string[] {
  return (window as DshWindow).__dshE2eErrors ?? []
}

/**
 * 帧内 dsh 页面是否已渲染出内容。
 * 选择器必须由调用方以参数传入：`browser.execute` 只序列化函数体。
 */
function dshRootRendered(selector: string): boolean {
  return (document.querySelector(selector)?.childElementCount ?? 0) > 0
}

/** `#root` 的文本（不含 `<script>` 源码，用来区分「渲染出界面」与「白屏」）。 */
function dshRootText(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? ''
}

describe.skipIf(process.platform === 'darwin')('桌面端启动冒烟', () => {
  let app: DesktopApp | undefined
  let browser: WebdriverIO.Browser

  beforeAll(async () => {
    app = await startDesktopApp({ coldCache: true })
    browser = app.browser

    // 尽早装壳层收集器：装配失败、iframe 加载失败都会在壳层留下痕迹
    await browser.execute(collectPageErrors)
    // 首次装配要先过「安装推荐插件」引导，服务才会被拉起
    await completePreinstall(browser, ASSEMBLY_TIMEOUT_MS)

    const iframeEl = await browser.$(SHELL_IFRAME)
    await iframeEl.waitForDisplayed({ timeout: ASSEMBLY_TIMEOUT_MS })
  }, ASSEMBLY_TIMEOUT_MS)

  afterAll(async () => {
    await app?.stop()
  })

  it('TC-DSK-L3-01-001 进入下载装配后 dsh 内核启动、页面渲染且无报错', async () => {
    // ① 进入下载：验证独占空缓存落盘情况
    const cacheDir = app?.downloadCacheDir ?? ''
    const dshPath = join(cacheDir, 'dependencies', 'dsh')
    expect(existsSync(dshPath), 'dsh 本体未落盘（装配没走下载）').toBe(true)

    // ② 内核启动：Node 运行时可用 + 服务地址 + iframe 挂载
    const info = await browser.execute(() => {
      return (window as DshWindow).__TAURI_INTERNALS__!.invoke('get_runtime_info')
    })

    expect(info.node_version, '未解析到可用 Node 运行时').not.toBe('')
    expect(info.service_url, '内核未给出服务地址').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const iframe = await browser.$(SHELL_IFRAME)
    expect(await iframe.isDisplayed(), 'iframe 未挂载（内核未就绪）').toBe(true)
    expect(await iframe.getAttribute('src'), 'iframe 未指向内核服务地址').toContain(info.service_url)

    // 简化多级 await：直接调用 element 方法
    expect(await browser.$(SHELL_ROOT).isExisting(), '壳层根节点缺失').toBe(true)
    expect(await browser.$(SETUP_ERROR).isExisting(), '壳层停在装配失败页').toBe(false)

    // ③ dsh 页面出现：进帧断言挂载点渲染出内容
    let rendered = ''
    let frameErrors: string[] = []

    await browser.switchFrame(iframe)
    try {
      await browser.execute(collectPageErrors)
      await browser.waitUntil(
        () => browser.execute(dshRootRendered, DSH_ROOT),
        { timeout: 60_000, timeoutMsg: 'dsh 页面未渲染（#root 无子节点）' },
      )

      // 页面渲染后仍有插件在异步加载，留一个观察窗口再取快照
      await browser.pause(SETTLE_MS)
      rendered = await browser.execute(dshRootText, DSH_ROOT)
      frameErrors = await browser.execute(readPageErrors)
    }
    finally {
      // 无论成功与否都退回顶层，避免后续断言运行在错误的帧上下文中
      await browser.switchFrame(null)
    }

    expect(rendered.length, 'dsh 页面渲染为空（白屏）').toBeGreaterThan(0)

    // ④ 页面无报错：帧内与壳层的收集器都必须为空
    expect(frameErrors, 'dsh 页面出现报错').toEqual([])

    const shellErrors = await browser.execute(readPageErrors)
    expect(shellErrors, '壳层出现报错').toEqual([])
  }, ASSEMBLY_TIMEOUT_MS)

  it('persists appearance through the native bridge and restores defaults', async () => {
    expect(await browser.execute(() => (window as unknown as { __DSH_STORE_FILE__: string }).__DSH_STORE_FILE__), '前端必须使用原生测试配置文件').toBe('.store.test.dat')
    async function click(id: string) {
      const element = await browser.$(`[data-testid="${id}"]`)
      await element.waitForClickable()
      await element.click()
    }
    async function appearance() {
      return browser.execute(async () => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ appearance: { palette: string, terminal: boolean, transparency: boolean, opacity: number, sidebarOnly: boolean } }> } }).__TAURI_INTERNALS__
        return (await bridge.invoke('get_app_config')).appearance
      })
    }
    await click('dsh-navbar-menu-config')
    await click('dsh-navbar-item-appearance')
    await click('dsh-appearance-palette')
    await click('dsh-appearance-palette-nord')
    await browser.waitUntil(async () => (await appearance()).palette === 'nord', { timeoutMsg: '原生设置未保存 Nord 配色' })
    const terminal = await browser.$('[data-testid="dsh-appearance-terminal"] input[role="switch"]')
    await terminal.waitForEnabled()
    // 内嵌驱动调用 HTMLElement.click；React Aria 的 label 会拦截它，须激活真实 input。
    await terminal.click()
    await browser.waitUntil(async () => (await appearance()).terminal, { timeoutMsg: '终端开关未通过原生桥保存' })
    const transparency = await browser.$('[data-testid="dsh-appearance-transparency"] input[role="switch"]')
    await transparency.waitForEnabled()
    await transparency.click()
    await browser.waitUntil(async () => (await appearance()).transparency)
    const opacity = await browser.$('[data-testid="dsh-appearance-opacity"] input[type="range"]')
    await opacity.waitForEnabled()
    await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="dsh-appearance-opacity"] input[type="range"]')!.focus())
    await browser.keys(Key.ArrowLeft)
    await browser.waitUntil(async () => (await appearance()).opacity === 99, { timeoutMsg: '原生设置未保存滑块的 99% 不透明度' })
    expect(await appearance(), '原生设置与所选外观不一致').toEqual({ palette: 'nord', terminal: true, transparency: true, opacity: 99, sidebarOnly: false })
    await click('dsh-appearance-reset')
    await browser.waitUntil(async () => (await appearance()).palette === 'default', { timeoutMsg: '原生外观设置未恢复默认值' })
    expect(await appearance(), '重置未还原完整原生外观设置').toEqual({ palette: 'default', terminal: false, transparency: false, opacity: 100, sidebarOnly: false })
    await click('dsh-config-dialog-close')
  })

  it('saves a proxy through the configuration UI and reloads the persisted value', async () => {
    async function click(id: string) {
      const element = await browser.$(`[data-testid="${id}"]`)
      await element.waitForClickable()
      await element.click()
    }
    async function proxyUrl() {
      return browser.execute(async () => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ proxy_url: string }> } }).__TAURI_INTERNALS__
        return (await bridge.invoke('get_app_config')).proxy_url
      })
    }
    const original = await proxyUrl()
    try {
      await click('dsh-navbar-menu-config')
      await click('dsh-navbar-item-network')
      const input = await browser.$(PROXY_URL)
      await input.waitForEnabled()
      await input.setValue('socks5h://127.0.0.1:1080')
      await browser.$(PROXY_SAVE).click()
      await browser.waitUntil(async () => await proxyUrl() === 'socks5h://127.0.0.1:1080', { timeoutMsg: '代理地址未保存到原生设置' })
      await click('dsh-config-dialog-close')
      await click('dsh-navbar-menu-config')
      await click('dsh-navbar-item-network')
      expect(await browser.$(PROXY_URL).getValue(), '重新打开配置后代理地址不一致').toBe('socks5h://127.0.0.1:1080')
      await browser.$(PROXY_URL).clearValue()
      await browser.$(PROXY_SAVE).click()
      await browser.waitUntil(async () => await proxyUrl() === '', { timeoutMsg: '清空代理未恢复继承设置' })
    }
    finally {
      await browser.execute(async (proxyUrl) => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
        await bridge.invoke('update_app_config', { proxyUrl })
      }, original)
      await click('dsh-config-dialog-close')
    }
  })

  it('persists shell zoom shortcuts without changing other native settings', async () => {
    async function config() {
      return browser.execute(() => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ zoom_factor: number, appearance: unknown, backup_include_credentials: boolean }> } }).__TAURI_INTERNALS__
        return bridge.invoke('get_app_config')
      })
    }
    async function shortcut(key: string) {
      await browser.execute((key) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
      }, key)
    }
    const original = await config()
    try {
      await shortcut('0')
      await browser.waitUntil(async () => (await config()).zoom_factor === 1, { timeoutMsg: '缩放重置未写入原生设置' })
      await shortcut('+')
      await shortcut('+')
      await browser.waitUntil(async () => (await config()).zoom_factor === 1.2, { timeoutMsg: '连续缩放快捷键未保存到原生设置' })
      const saved = await config()
      expect(saved.appearance, '缩放不应覆盖原生外观设置').toEqual(original.appearance)
      expect(saved.backup_include_credentials, '缩放不应覆盖凭证备份偏好').toBe(original.backup_include_credentials)
    }
    finally {
      await browser.execute(async (zoomFactor) => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
        await bridge.invoke('update_app_config', { zoomFactor })
      }, original.zoom_factor)
    }
  })
})
