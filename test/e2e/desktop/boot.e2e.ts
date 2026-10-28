import type { DesktopApp } from '../support/desktop'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startDesktopApp } from '../support/desktop'
import { completePreinstall } from '../support/preinstall'
import { SETUP_ERROR, SHELL_IFRAME, SHELL_ROOT } from '../support/selectors'

/** 全局 Window 类型扩展，用于解决浏览器环境上下文注入报错 */
interface DshWindow extends Window {
  __dshE2eErrors?: string[]
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string) => Promise<{ service_url: string, node_version: string, dsh_version: string, data_dir: string, log_path: string }>
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

describe('桌面端启动冒烟', () => {
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
    expect(info.dsh_version, '冷装配必须实际启动推荐的 rc.4 核心').toBe('0.2.1-rc.4')
    expect(resolve(info.data_dir), '真实核心数据根必须隔离在本次 scratch').toBe(resolve(app!.home, 'home', '.dsh.dev'))
    const logRelative = relative(app!.downloadCacheDir, info.log_path)
    expect(isAbsolute(logRelative) || logRelative === '..' || logRelative.startsWith('../') || logRelative.startsWith('..\\'), '真实核心日志不得写入用户运行实例目录').toBe(false)
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

  it('TC-DSK-L3-993 原生窗口继承档案、复用同档案核心且切换与关闭不重启其他核心', async () => {
    const windows: string[] = []
    async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      return browser.execute(async (command, args) => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__
        return bridge.invoke(command, args)
      }, command, args)
    }
    async function activeProfile() {
      const profiles = await invoke<{ id: string, active: boolean }[]>('get_profiles')
      const active = profiles.find(profile => profile.active)
      expect(active, '当前原生窗口必须有活动档案').toBeDefined()
      return active!.id
    }
    async function openWindow() {
      const before = await browser.getWindowHandles()
      await invoke('create_app_window')
      await browser.waitUntil(async () => (await browser.getWindowHandles()).some(handle => !before.includes(handle)), { timeout: 30_000, timeoutMsg: '原生新窗口未创建' })
      const handle = (await browser.getWindowHandles()).find(handle => !before.includes(handle))!
      windows.push(handle)
      await browser.switchToWindow(handle)
      await browser.$(SHELL_ROOT).waitForExist({ timeout: 30_000 })
      return handle
    }
    async function closeWindow(handle: string) {
      const { protocol, hostname, port, path } = browser.options
      // WDIO 的 closeWindow 回包会触发未等待的自动切窗，绕过该命令事件。
      const response = await fetch(`${protocol}://${hostname}:${port}${(path ?? '').replace(/\/+$/, '')}/session/${encodeURIComponent(browser.sessionId)}/window`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) })
      const result = await response.json()
      expect(response.ok, `关闭原生窗口 ${handle} HTTP ${response.status}: ${JSON.stringify(result)}`).toBe(true)
      expect(result, `关闭原生窗口 ${handle} 协议失败`).toEqual({ value: expect.any(Array) })
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(handle), { timeout: 30_000, timeoutMsg: `原生窗口 ${handle} 未销毁` })
    }
    async function healthy() {
      return (await invoke<{ status: string }>('proxy_health_check')).status
    }
    let clonedProfile: string | undefined
    let switchedProfile = false
    await browser.switchToWindow('main')
    const originalProfile = await activeProfile()
    const originalRuntime = await invoke<{ service_url: string }>('get_runtime_info')
    expect(await healthy(), '原窗口核心必须已就绪').toMatch(/^healthy - \d+\/\d+ client modules ready$/)
    const profilesRoot = join(app!.home, 'home', '.dsh.dev', 'profiles')
    const originalMarkerPath = join(profilesRoot, originalProfile, '.harness.pid')
    const originalMarker = readFileSync(originalMarkerPath, 'utf8')
    try {
      const clone = await invoke<{ id: string }>('clone_profile', { sourceId: originalProfile, name: 'native-window-993' })
      clonedProfile = clone.id
      const second = await openWindow()
      expect(await activeProfile(), '新窗口必须继承发起窗口档案').toBe(originalProfile)
      expect((await invoke<{ service_url: string }>('get_runtime_info')).service_url, '同档案新窗口必须复用服务端口').toBe(originalRuntime.service_url)
      await invoke('set_active_profile', { id: clone.id })
      switchedProfile = true
      await invoke('launch_harness')
      await browser.waitUntil(async () => {
        const result = await browser.execute(async () => {
          const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ status: string }> } }).__TAURI_INTERNALS__
          return bridge.invoke('proxy_health_check').then(value => value.status.startsWith('healthy - '), (error: unknown) => {
            if (String(error).startsWith('HARNESS_NOT_READY:'))
              return false
            throw error
          })
        })
        return result
      }, { timeout: ASSEMBLY_TIMEOUT_MS, timeoutMsg: '第二档案核心未就绪' })
      expect(await activeProfile(), '切换应只改变第二窗口档案').toBe(clone.id)
      const secondRuntime = await invoke<{ service_url: string }>('get_runtime_info')
      expect(secondRuntime.service_url, '不同档案必须使用独立服务端口').not.toBe(originalRuntime.service_url)
      const clonedMarkerPath = join(profilesRoot, clone.id, '.harness.pid')
      const clonedMarker = readFileSync(clonedMarkerPath, 'utf8')
      expect(clonedMarker.split('\n')[0], '不同档案必须持有不同核心进程').not.toBe(originalMarker.split('\n')[0])
      const third = await openWindow()
      await invoke('launch_harness')
      expect(await activeProfile(), '第三窗口必须继承第二窗口档案').toBe(clone.id)
      expect((await invoke<{ service_url: string }>('get_runtime_info')).service_url, '第二档案的窗口必须复用核心端口').toBe(secondRuntime.service_url)
      expect(readFileSync(clonedMarkerPath, 'utf8'), '同档案新窗口不得重启已有核心').toBe(clonedMarker)
      await browser.switchToWindow('main')
      expect(await activeProfile(), '其他窗口切档案不得改变原窗口档案').toBe(originalProfile)
      expect((await invoke<{ service_url: string }>('get_runtime_info')).service_url, '其他窗口切档案不得改变原核心端口').toBe(originalRuntime.service_url)
      expect(readFileSync(originalMarkerPath, 'utf8'), '其他窗口切档案不得重启原核心').toBe(originalMarker)
      expect(await healthy(), '第二档案启动后原核心必须仍健康').toMatch(/^healthy - /)
      await browser.switchToWindow(third)
      await closeWindow(third)
      await browser.switchToWindow(second)
      expect(await healthy(), '关闭同档案的非最后窗口不得停止核心').toMatch(/^healthy - /)
      await closeWindow(second)
      await browser.switchToWindow('main')
      await browser.waitUntil(async () => !existsSync(clonedMarkerPath), { timeout: 30_000, timeoutMsg: '关闭档案最后窗口后核心 PID 标记未回收' })
      expect(readFileSync(originalMarkerPath, 'utf8'), '关闭其他档案窗口不得重启原核心').toBe(originalMarker)
      expect(await healthy(), '关闭其他档案最后窗口后原核心必须仍健康').toMatch(/^healthy - /)
    }
    finally {
      for (const handle of windows.reverse()) {
        if ((await browser.getWindowHandles()).includes(handle)) {
          await browser.switchToWindow(handle)
          await closeWindow(handle)
        }
      }
      await browser.switchToWindow('main')
      if (switchedProfile)
        await invoke('set_active_profile', { id: originalProfile })
      if (clonedProfile) {
        await browser.waitUntil(async () => !existsSync(join(profilesRoot, clonedProfile!, '.harness.pid')), { timeout: 30_000, timeoutMsg: '测试档案核心未完成关闭回收' })
        await invoke('remove_profile', { id: clonedProfile })
      }
    }
  }, ASSEMBLY_TIMEOUT_MS)

  it('persists appearance through the native bridge and restores defaults', async () => {
    expect(await browser.execute(() => (window as unknown as { __DSH_STORE_FILE__: string }).__DSH_STORE_FILE__), '前端必须使用原生测试配置文件').toBe('.store.test.dat')
    async function click(id: string) {
      const element = await browser.$(`[data-testid="${id}"]`)
      await element.waitForClickable()
      await element.click()
    }
    async function config() {
      return browser.execute(async () => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ zoom_factor: number, appearance: { palette: string, terminal: boolean, transparency: boolean, opacity: number, blur: boolean, sidebarOnly: boolean } }> } }).__TAURI_INTERNALS__
        return bridge.invoke('get_app_config')
      })
    }
    async function appearance() {
      return (await config()).appearance
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
    expect(await appearance(), '开启原生透明未应用默认组合').toEqual({ palette: 'nord', terminal: true, transparency: true, opacity: 80, blur: true, sidebarOnly: true })
    const opacity = await browser.$('[data-testid="dsh-appearance-opacity"] input[type="range"]')
    await opacity.waitForEnabled()
    await browser.execute(() => document.querySelector<HTMLInputElement>('[data-testid="dsh-appearance-opacity"] input[type="range"]')!.focus())
    await browser.keys(Key.ArrowLeft)
    await browser.waitUntil(async () => (await appearance()).opacity === 79, { timeoutMsg: '原生设置未保存滑块的 79% 不透明度' })
    const sidebarOnly = await browser.$('[data-testid="dsh-appearance-sidebar-only"] input[role="switch"]')
    await sidebarOnly.waitForEnabled()
    await sidebarOnly.click()
    await browser.waitUntil(async () => !(await appearance()).sidebarOnly, { timeoutMsg: '原生设置未保存内容区不透明开关' })
    await click('dsh-appearance-zoom')
    await click('dsh-appearance-zoom-1.2')
    await browser.waitUntil(async () => (await config()).zoom_factor === 1.2, { timeoutMsg: '本机界面缩放未从外观面板保存' })
    expect(await appearance(), '原生设置与所选外观不一致').toEqual({ palette: 'nord', terminal: true, transparency: true, opacity: 79, blur: true, sidebarOnly: false })
    const storePath = join(app!.home, 'app-data', '.store.test.dat')
    await expect.poll(() => existsSync(storePath), { message: '原生 Store 必须真实保存到本次隔离 app-data' }).toBe(true)
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { setting: { zoom_factor: number, appearance: unknown } }
    expect(persisted.setting.appearance, '隔离 Store 中必须存在刚保存的原生外观设置').toEqual(await appearance())
    expect(persisted.setting.zoom_factor, '隔离 Store 中必须存在刚保存的缩放值').toBe(1.2)
    await click('dsh-appearance-reset')
    await browser.waitUntil(async () => (await appearance()).palette === 'default', { timeoutMsg: '原生外观设置未恢复默认值' })
    expect(await appearance(), '重置未还原完整原生外观设置').toEqual({ palette: 'default', terminal: false, transparency: false, opacity: 100, blur: false, sidebarOnly: false })
    expect((await config()).zoom_factor, '重置未还原本机界面缩放').toBe(1)
    await click('dsh-config-dialog-close')
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
