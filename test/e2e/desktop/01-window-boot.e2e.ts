/**
 * L3 桌面端 E2E：窗口启动。
 *
 * 用例来源：docs/testing/desktop/01-window-boot.md，一个 `it()` 对应一条用例。
 * 编排：test/e2e/support/desktop-host.ts
 *
 * 运行：pnpm test:e2e:desktop
 *   前置：`dist/` 与 `src-tauri/target/debug/` 的二进制已按最新源码重建；
 *         3081 空闲；无残留桌面实例。
 */

import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_PORT,
  APP_TITLE,
  assertPreconditions,
  defaultBinaryPath,
  startDesktopApp,
} from '../support/desktop-host'

/**
 * 控制台错误白名单（`01-window-boot.md` G-D01-2）。
 *
 * 只放与本用例断言目标无关、且在当前 WebView2 环境下稳定复现的噪声；
 * 新增条目必须写明来源，否则会把真实回归一起吞掉。
 */
const CONSOLE_ERROR_WHITELIST: readonly RegExp[] = [
  // WebView2 在无 GPU 的会话里会报这些，与壳层渲染无关。
  /GPU state invalid/i,
  /Autofill\./,
]

const SHELL_ROOT = '[data-testid="dsh-shell-root"]'
const NAVBAR_ROOT = '[data-testid="dsh-navbar-root"]'
const DEV_CHIP = '[data-testid="dsh-navbar-dev-chip"]'

let browser: WebdriverIO.Browser
let stop: () => Promise<void>

beforeAll(async () => {
  // 本批只验壳层启动，不覆盖装配流程：选择禁用自动下载，避免每次运行都做联网
  // 版本核对。下载物另由 `DSH_DOWNLOAD_CACHE_DIR` 缓存复用；要测装配流程的用例
  // 需自行 `resetDownloadCache()` 并保持 `disableDownload: false`。
  const app = await startDesktopApp({ disableDownload: true })
  browser = app.browser
  stop = app.stop
})

afterAll(async () => {
  await stop?.()
})

describe('窗口启动', () => {
  it('TC-DSK-L3-001 验证应用启动后主窗口存在且标题正确', async () => {
    const handles = await browser.getWindowHandles()
    expect(handles).toEqual(['main'])

    const title = await browser.getTitle()
    expect(title).toBe(APP_TITLE)
  })

  it('TC-DSK-L3-002 验证壳层根节点渲染且页面无未捕获错误', async () => {
    const shell = await browser.$(SHELL_ROOT)
    await shell.waitForDisplayed()

    const errors: string[] = await browser.execute(() => {
      const collected = (window as unknown as { __e2eConsoleErrors?: string[] }).__e2eConsoleErrors ?? []
      return collected
    })

    const unexpected = errors.filter(message => !CONSOLE_ERROR_WHITELIST.some(re => re.test(message)))
    expect(unexpected).toEqual([])
  })

  it('TC-DSK-L3-003 验证壳层导航栏高度为 44px', async () => {
    const navbar = await browser.$(NAVBAR_ROOT)
    await navbar.waitForDisplayed()

    const height = await navbar.getSize('height')
    expect(height).toBe(44)
  })

  it('TC-DSK-L3-004 验证主窗口初始尺寸为 1280×840', async () => {
    // 断言的是逻辑像素：`inner_size(1280, 840)` 是逻辑值，而 WebDriver 读回的
    // CSS 像素随显示器缩放变化（实测 150% 下 inner 为 854×560）。按 DPR 还原后
    // 与 1280×840 比较（G-D01-1）。
    const [innerWidth, innerHeight, dpr] = await browser.execute(() => [
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio,
    ]) as [number, number, number]

    const logicalWidth = innerWidth * dpr
    const logicalHeight = innerHeight * dpr

    // 取整误差：CSS 像素是整数，150% 下 1280 只能表示成 854（×1.5 = 1281）。
    expect(Math.abs(logicalWidth - 1_280)).toBeLessThanOrEqual(2)
    expect(Math.abs(logicalHeight - 840)).toBeLessThanOrEqual(2)
  })

  // TC-DSK-L3-005（窗口最小尺寸约束 860×620）在本通道不可自动断言：
  // embedded driver 的 SetWindowRect 直接落 SetWindowPos，绕过 tao 的最小尺寸约束，
  // 请求 400×300 会真的变成 400×300。该用例已在文档中改标「否（手工）」，见 G-D01-4。

  it('TC-DSK-L3-006 验证生产构建不显示开发环境标记', async () => {
    // `01` 批次跑的是 `vite build` 产物，`import.meta.env.DEV` 为 false，
    // DEV 标记本就不应渲染。反向（dev 构建下可见）需 `tauri dev` 通道，见 G-D01-5。
    const chip = await browser.$(DEV_CHIP)
    expect(await chip.isExisting()).toBe(false)
  })

  it('TC-DSK-L3-007 [反向] 验证二进制缺失时启动失败并给出可判定错误', async () => {
    const missing = `${defaultBinaryPath()}.__missing__`
    expect(existsSync(missing)).toBe(false)

    await expect(startDesktopApp({ appBinaryPath: missing, requireBinary: true })).rejects.toThrow(missing)
  })

  it('TC-DSK-L3-008 [反向] 验证默认端口被占用时前置校验直接失败且不强杀进程', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise<void>(resolvePromise => blocker.listen(APP_PORT, '127.0.0.1', resolvePromise))

    try {
      await expect(assertPreconditions({ port: APP_PORT })).rejects.toThrow(String(APP_PORT))
      // 占用者未被强杀：端口仍在监听。
      const stillListening = blocker.listening
      expect(stillListening).toBe(true)

      const recycled = await new Promise<boolean>((resolvePromise) => {
        const probe = createServer()
        probe.once('error', () => resolvePromise(false))
        probe.listen(APP_PORT, '127.0.0.1', () => {
          probe.close(() => resolvePromise(false))
          resolvePromise(true)
        })
      })
      expect(recycled).toBe(false)
    }
    finally {
      await new Promise<void>(resolvePromise => blocker.close(() => resolvePromise()))
    }
  })
})
