import type { DesktopApp } from '../support/desktop'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDesktopApp } from '../support/desktop'
import { dismissDshModals } from '../support/onboarding'
import { completePreinstall } from '../support/preinstall'
import { SHELL_IFRAME } from '../support/selectors'

// ==========================================
// 1. 常量配置
// ==========================================

/** 冷装配（真的联网下载 Node + dsh）的等待上限。 */
const ASSEMBLY_TIMEOUT_MS = 900_000

/** 桌宠窗口创建/销毁的收敛窗口（Rust 侧建窗是异步的）。 */
const PET_WINDOW_TIMEOUT_MS = 30_000

/** 插件就绪锚点：插件样式元素（`mountStyle` 交给 css-render 落成 `style[cssr-id=…]`）。 */
const PET_STYLES = 'style[cssr-id="dsh-tauri-pet-styles"]'

/** 桌宠尺寸合法区间（`src-tauri/src/desktop/pet.rs:48-49` 的 50.0 / 200.0）。 */
const PET_SIZE_MIN = 50
const PET_SIZE_MAX = 200
const PET_SIZE_DEFAULT = 100

// ==========================================
// 2. 类型定义
// ==========================================

interface PetStatus {
  enabled?: boolean
  visible?: boolean
  active_pet?: string
  pet_size?: number | null
}

interface WindowWithDshErrors extends Window {
  __dshE2eErrors?: string[]
  __TAURI_INTERNALS__?: {
    invoke: (name: string, payload?: Record<string, unknown>) => Promise<unknown>
  }
}

// ==========================================
// 3. 浏览器端 DOM/Tauri 脚本函数（在 `browser.execute` 中执行）
// ==========================================

/** 元素是否存在 */
function elementExists(selector: string): boolean {
  return document.querySelector(selector) !== null
}

/** 在页面（壳层或帧内）安装报错收集器：三类页面级错误收进 `window.__dshE2eErrors` */
function collectPageErrors(): void {
  const host = window as unknown as WindowWithDshErrors
  if (host.__dshE2eErrors)
    return

  const errors: string[] = []
  host.__dshE2eErrors = errors

  window.addEventListener('error', event => errors.push(`error: ${event.message}`))
  window.addEventListener('unhandledrejection', event => errors.push(`unhandledrejection: ${String(event.reason)}`))

  const originalConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    errors.push(`console.error: ${args.map(String).join(' ')}`)
    originalConsoleError(...args)
  }
}

/** 读回当前上下文的报错收集器 */
function readPageErrors(): string[] {
  return (window as unknown as WindowWithDshErrors).__dshE2eErrors ?? []
}

/** 壳层内调用 Tauri 命令 */
function shellInvoke(cmd: string, args?: unknown): Promise<unknown> {
  const internals = (window as unknown as WindowWithDshErrors).__TAURI_INTERNALS__
  if (!internals) {
    throw new Error('壳层缺少 __TAURI_INTERNALS__：当前上下文不是 Tauri WebView')
  }
  return internals.invoke(cmd, args as Record<string, unknown> | undefined)
}

// ==========================================
// 4. 测试套件
// ==========================================

describe.skipIf(process.platform !== 'win32')('桌面端桌宠独立窗口', () => {
  let app: DesktopApp

  beforeAll(async () => {
    app = await startDesktopApp()
    const browser = app.browser

    // 尽早装壳层收集器：装配失败、iframe 加载失败都会在壳层留下痕迹
    await browser.execute(collectPageErrors)
    const iframe = await browser.$(SHELL_IFRAME)
    await completePreinstall(browser, ASSEMBLY_TIMEOUT_MS)
    await iframe.waitForDisplayed({ timeout: ASSEMBLY_TIMEOUT_MS })

    // 切入 iframe 安装收集器并等待 UI 渲染。
    //
    // 就绪锚点必须覆盖「插件真的挂上了菜单入口」这一步：只等桌宠样式就进用例，会让第一条
    // 用例去和菜单锚的挂载赛跑（CI 上曾整轮输掉这场赛跑）。桌宠条目由插件在菜单展开时才
    // 克隆出来，这里只能等到入口存在。
    await withIframe(async () => {
      await browser.execute(collectPageErrors)
      await browser.waitUntil(
        () => browser.execute(elementExists, PET_STYLES),
        { timeout: 60_000, timeoutMsg: '内嵌 dsh 界面未渲染出桌宠插件产物（插件 client 未生效）' },
      )
      try {
        await browser.waitUntil(
          () => browser.execute(elementExists, ACCOUNT_MENU_TRIGGER),
          { timeout: 60_000, timeoutMsg: '菜单入口未渲染（账号菜单锚缺席）' },
        )
      }
      catch (error) {
        // 入口缺席时把现场钉进失败信息：只看超时文案分不清「插件没挂上」「菜单锚存在但
        // 触发器没渲染」还是「帧内报错把渲染打断了」，CI 上无从复盘。
        throw new Error(`${(error as Error).message}\n${await describeSettingsScene()}`)
      }
    })

    await dismissDshModals(browser)
    await setEnabled(false)
  }, ASSEMBLY_TIMEOUT_MS)

  afterAll(async () => {
    await app?.stop()
  })

  // ------------------------------------------
  // Helper 函数库（特定于套件）
  // ------------------------------------------

  /** 封装 iframe 切换的高阶函数，自动保证调用后切回主框架 */
  async function withIframe<T>(action: () => Promise<T>): Promise<T> {
    const browser = app.browser
    const iframe = await browser.$(SHELL_IFRAME)
    await browser.switchFrame(iframe)
    try {
      return await action()
    }
    finally {
      await browser.switchFrame(null)
    }
  }

  /** 壳层报错快照（当前上下文必须已在壳层） */
  async function shellErrors(): Promise<string[]> {
    return (await app.browser.execute(readPageErrors)) as string[]
  }

  /** 帧内报错快照：自动进出 iframe */
  async function frameErrors(): Promise<string[]> {
    return withIframe(() => app.browser.execute(readPageErrors) as Promise<string[]>)
  }

  /** 收尾断言：壳层与内嵌 dsh 页面都不得留下未捕获错误 */
  async function expectNoPageErrors(scene: string): Promise<void> {
    expect(await frameErrors(), `${scene}：内嵌 dsh 页面出现报错`).toEqual([])
    expect(await shellErrors(), `${scene}：壳层出现报错`).toEqual([])
  }

  /** 壳层读状态 */
  async function status(): Promise<PetStatus> {
    return (await app.browser.execute(shellInvoke, 'get_pet_status')) as PetStatus
  }

  /** 壳层写启用状态 */
  async function setEnabled(enabled: boolean): Promise<void> {
    await app.browser.execute(shellInvoke, 'set_pet_enabled', { enabled })
    await app.browser.waitUntil(
      async () => (await status()).enabled === enabled,
      { timeout: PET_WINDOW_TIMEOUT_MS, timeoutMsg: `把 enabled 写成 ${enabled} 后状态未收敛` },
    )
  }

  /** 越界提交必须由命令层拒绝（暂禁 WDIO 500 重试机制） */
  async function expectSizeRejected(outOfRange: number): Promise<void> {
    const browser = app.browser
    const retryCount = browser.options.connectionRetryCount
    browser.options.connectionRetryCount = 0

    try {
      await expect(
        browser.execute(shellInvoke, 'set_pet_size', { size: outOfRange }),
      ).rejects.toThrow(/PET_SIZE_OUT_OF_RANGE/)
    }
    finally {
      browser.options.connectionRetryCount = retryCount
    }
  }

  // ------------------------------------------
  // 5. 测试用例集
  // ------------------------------------------

  it('TC-PET-L3-02-004 桌宠尺寸边界：范围内接受、越界拒绝且不改状态', async () => {
    await setEnabled(true)

    for (const inRange of [PET_SIZE_MIN, PET_SIZE_MAX]) {
      await app.browser.execute(shellInvoke, 'set_pet_size', { size: inRange })
      expect((await status()).pet_size, `范围内提交 ${inRange} 必须被接受并落盘`).toBe(inRange)
    }

    const settled = (await status()).pet_size
    for (const outOfRange of [0, PET_SIZE_MIN - 1, PET_SIZE_MAX + 1, 999]) {
      await expectSizeRejected(outOfRange)
      expect(
        (await status()).pet_size,
        `越界提交 ${outOfRange} 不得改动已落盘的尺寸`,
      ).toBe(settled)
    }

    await app.browser.execute(shellInvoke, 'set_pet_size', { size: PET_SIZE_DEFAULT })
    expect((await status()).pet_size, '收尾必须恢复默认尺寸').toBe(PET_SIZE_DEFAULT)
    await setEnabled(false)

    await expectNoPageErrors('TC-PET-L3-02-004 尺寸边界')
  })
})
