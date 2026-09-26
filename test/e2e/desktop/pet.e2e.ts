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

/** 主窗口 label，同时也是 WebDriver 的 window handle。 */
const MAIN_WEBVIEW = 'main'

/** 桌宠独立窗口 label（`src-tauri/src/desktop/pet.rs:29`）。 */
const PET_WEBVIEW = 'pet'

/** 插件就绪锚点：插件样式元素（`mountStyle` 交给 css-render 落成 `style[cssr-id=…]`）。 */
const PET_STYLES = 'style[cssr-id="dsh-tauri-pet-styles"]'

/** 设置入口触发器（`packages/dsh-tauri-ui/src/client/ui/trigger.tsx`）。 */
const SETTINGS_TRIGGER = '.dshp-settings-trigger'

/** 设置菜单里的桌宠条目（`packages/dsh-tauri-pet/src/client/constants/index.ts`）。 */
const PET_MENU_ITEM = '[data-dsh-tauri-pet-menu-item="1"]'

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

/** 匹配元素的数量（`browser.$$` 的 `length` 在 WDIO 9 里是 Promise，脚本函数更直接） */
function elementCount(selector: string): number {
  return document.querySelectorAll(selector).length
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

    // 切入 iframe 安装收集器并等待 UI 渲染
    await withIframe(async () => {
      await browser.execute(collectPageErrors)
      await browser.waitUntil(
        () => browser.execute(elementExists, PET_STYLES),
        { timeout: 60_000, timeoutMsg: '内嵌 dsh 界面未渲染出桌宠插件产物（插件 client 未生效）' },
      )
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

  /** 等窗口句柄集合收敛到期望值 */
  async function waitHandles(expected: string[], message: string): Promise<void> {
    await app.browser.waitUntil(
      async () => {
        const handles = await app.browser.getWindowHandles()
        return handles.length === expected.length && expected.every(handle => handles.includes(handle))
      },
      { timeout: PET_WINDOW_TIMEOUT_MS, timeoutMsg: message },
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

  /**
   * 帧内打开设置入口，并等菜单里出现唯一的桌宠条目。
   *
   * 桌宠条目由插件在「设置」菜单展开时才克隆出来，只有菜单处于展开态才存在；
   * `.dshp-settings-trigger` / `data-dsh-tauri-pet-menu-item` 都是插件自有的稳定选择器。
   */
  async function openPetMenu(): Promise<void> {
    const browser = app.browser
    await dismissDshModals(browser)

    await withIframe(async () => {
      try {
        await browser.waitUntil(
          () => browser.execute(elementExists, SETTINGS_TRIGGER),
          { timeout: 60_000, timeoutMsg: '设置入口未渲染（dsh-tauri-ui 未生效）' },
        )
      }
      catch (error) {
        // 入口缺席时把现场钉进失败信息：只看超时文案分不清「插件没挂上」「侧栏存在但
        // 触发器没渲染」还是「帧内报错把渲染打断了」，CI 上无从复盘。
        throw new Error(`${(error as Error).message}\n${await describeSettingsScene()}`)
      }

      const trigger = await browser.$(SETTINGS_TRIGGER)
      if (await trigger.getAttribute('aria-expanded') !== 'true')
        await trigger.click()

      await browser.waitUntil(
        async () => await browser.execute(elementCount, PET_MENU_ITEM) === 1,
        { timeout: 30_000, timeoutMsg: '设置菜单展开后必须出现唯一的桌宠条目' },
      )
    })
  }

  /** 帧内设置现场快照：入口/侧栏/根节点是否存在 + 页内错误，用于入口缺席时的定位。 */
  async function describeSettingsScene(): Promise<string> {
    return await app.browser.execute(() => {
      const host = window as unknown as WindowWithDshErrors
      const count = (selector: string): number => document.querySelectorAll(selector).length
      return JSON.stringify({
        readyState: document.readyState,
        trigger: count('.dshp-settings-trigger'),
        sidebarRoot: count('[data-slot-sidebar="dsh-tauri-ui"]'),
        sidebarSlot: count('[data-slot="sidebar"]'),
        root: count('#root'),
        petStyles: count('style[cssr-id="dsh-tauri-pet-styles"]'),
        petMenuItem: count('[data-dsh-tauri-pet-menu-item="1"]'),
        errors: (host.__dshE2eErrors ?? []).slice(0, 5),
      })
    }) as string
  }

  /** 帧内点击设置菜单里的桌宠条目（用户路径的唯一开关入口），随后菜单自行收起。 */
  async function togglePet(): Promise<void> {
    const browser = app.browser
    await openPetMenu()

    await withIframe(async () => {
      await (await browser.$(PET_MENU_ITEM)).click()
    })

    await dismissDshModals(browser)
  }

  /** 从设置菜单切换桌宠，先断后端状态真的翻转，再等窗口句柄收敛（全部断言 Tauri 原生产物）。 */
  async function togglePetExpecting(expected: string[], message: string): Promise<void> {
    const before = (await status()).enabled
    expect(before, '切换前必须能读到后端 enabled 状态（否则后端已失联）').toBeTypeOf('boolean')

    await togglePet()

    expect((await status()).enabled, `点击桌宠条目后后端 enabled 必须从 ${before} 翻转`).toBe(!before)
    await waitHandles(expected, message)
  }

  // ------------------------------------------
  // 5. 测试用例集
  // ------------------------------------------

  it('TC-PET-L3-02-001 启用后出现独立的桌宠窗口', async () => {
    await waitHandles([MAIN_WEBVIEW], '复位后窗口句柄必须恰为主窗口')

    await togglePetExpecting([MAIN_WEBVIEW, PET_WEBVIEW], '点击设置菜单里的桌宠条目后必须出现独立的 pet 窗口句柄')

    const state = await status()
    expect(state.enabled, '创建窗口后状态必须为 enabled:true').toBe(true)
    expect(state.visible, 'enabled 为真时 visible 必须同为真').toBe(true)

    await togglePetExpecting([MAIN_WEBVIEW], '再次点击桌宠条目后 pet 窗口必须销毁')
    expect((await status()).enabled, '关闭后状态必须回到 enabled:false').toBe(false)

    await expectNoPageErrors('TC-PET-L3-02-001 建窗/销毁全流程')
  })

  it('TC-PET-L3-02-002 [反向] 未启用桌宠时不存在桌宠窗口', async () => {
    await setEnabled(false)

    const state = await status()
    expect(state.enabled, '关闭态下必需为 false').toBe(false)
    expect(state.visible, '未启用时不得报告可见').toBe(false)
    expect(await app.browser.getWindowHandles(), '未启用时窗口句柄必须恰为 [main]').toEqual([MAIN_WEBVIEW])
  })

  it('TC-PET-L3-02-003 设置菜单桌宠条目切换后窗口随之创建与销毁', async () => {
    await setEnabled(false)
    await waitHandles([MAIN_WEBVIEW], '复位后窗口句柄必须恰为主窗口')
    expect((await status()).enabled, '复位后后端必须停在关闭态').toBe(false)

    await togglePetExpecting([MAIN_WEBVIEW, PET_WEBVIEW], '首次点击后必须出现 pet 窗口')
    expect((await status()).enabled, '首次点击后状态必须为 enabled:true').toBe(true)

    await togglePetExpecting([MAIN_WEBVIEW], '二次点击后 pet 窗口必须销毁')
    expect((await status()).enabled, '二次点击后状态必须回到 enabled:false').toBe(false)

    await expectNoPageErrors('TC-PET-L3-02-003 点击切换往返')
  })

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
