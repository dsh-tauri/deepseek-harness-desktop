import type { Page } from 'playwright'
import type { RuntimeInfo } from '../setup/harness'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { waitHealthy } from '../setup/harness'
import { ASSEMBLY_TIMEOUT_MS, collectPageErrors, completePreinstall, CONFIG_DIALOG, CONFIG_RELOAD_PAGE, diagnose, installErrorCollector, invoke, MAIN_LABEL, NAVBAR_MENU_CONFIG, NAVBAR_MENU_POPOVER, pageErrors, SHELL_ROOT, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

interface BrowserReservation {
  lease: string
  partition: string
}

const app = shellAppScope()

beforeAll(async () => {
  try {
    await completePreinstall(app.get().window.page, ASSEMBLY_TIMEOUT_MS)
  }
  catch (error) {
    console.error('[e2e-assembly] 原始错误', error)
    try {
      console.error(`[e2e-assembly] ${await diagnose(app.get())}`)
    }
    catch (diagnosticError) {
      console.error('[e2e-assembly] 诊断不可用', String(diagnosticError))
    }
    throw error
  }
}, ASSEMBLY_TIMEOUT_MS)

describe('desktop boot and profile lifecycle', () => {
  it('boots an isolated Electron shell with a ready Harness runtime', async () => {
    const shell = app.get()
    await shell.window.page.context().addInitScript(collectPageErrors)
    await installErrorCollector(shell.window.page)
    await expect.poll(() => shell.window.page.locator(SHELL_ROOT).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: 'Electron 壳层必须完成首屏渲染' }).toBe(true)

    const health = await waitHealthy(shell.window.page)
    const info = await invoke<RuntimeInfo>(shell.window.page, 'get_runtime_info')
    expect(info.app_version, '运行时必须返回桌面应用版本').toBeTruthy()
    expect(info.node_version, '运行时必须返回 Node 版本').toBeTruthy()
    expect(info.service_url, '运行时必须返回 Harness 服务地址').toBe(health.service_url)
    expect(info.data_dir, '运行时必须返回隔离数据目录').toContain(shell.home)
    expect(info.log_path, '运行时必须返回服务日志路径').toContain(shell.downloadCacheDir)
    expect(info.platform, '运行时必须返回平台').toBe(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')
    expect(info.arch, '运行时必须返回架构').toBeTruthy()
    expect(await pageErrors(shell.window.page), '启动过程不应产生页面异常').toEqual([])
  })

  it('exposes the host path bridge to the Harness page', async () => {
    const shell = app.get()
    const health = await waitHealthy(shell.window.page)
    const origin = new URL(health.service_url).origin
    const processes = await invoke<{ pid: number, kind: string }[]>(shell.window.page, 'get_task_manager_processes')
    expect(processes.some(process => process.kind === 'desktop'), '托管壳层任务管理器必须可读取本应用进程').toBe(true)
    let harness: Page | undefined
    await expect.poll(() => {
      harness = shell.browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(`${origin}/`))
      return Boolean(harness)
    }, { timeout: WINDOW_TIMEOUT_MS, message: '健康服务必须对应真实的 Harness 页面' }).toBe(true)
    const page = harness!
    await expect.poll(() => page.evaluate(() => document.readyState), { timeout: WINDOW_TIMEOUT_MS, message: 'Harness 页面必须完成加载' }).toBe('complete')
    expect(await page.evaluate(() => typeof (globalThis as { __DSH_HOST_PATHS__?: { pathFor: (file: File) => string } }).__DSH_HOST_PATHS__?.pathFor)).toBe('function')
    expect(await page.evaluate(() => {
      const bridge = (globalThis as { __DSH_HOST_PATHS__?: { pathFor: (file: File) => string } }).__DSH_HOST_PATHS__
      return bridge === undefined ? 'missing' : bridge.pathFor(new File([], 'synthetic.txt'))
    }), '无宿主路径的文件必须回落为空串，而不是抛错').toBe('')
  })

  it('acquires and releases a Browser guest partition through the native bridge', async () => {
    const main = app.get().window.page
    await waitHealthy(main)
    const workspace = `e2e-${randomUUID()}`
    const reservation = await main.evaluate(async (value) => {
      const bridge = (window as Window & { dshDesktop?: { browser?: { acquire: (workspace: string) => Promise<BrowserReservation>, release: (lease: string) => Promise<void> } } }).dshDesktop?.browser
      if (!bridge)
        throw new Error('Native Browser bridge is unavailable')
      return await bridge.acquire(value)
    }, workspace)
    try {
      expect(reservation.lease, '原生 Browser bridge 必须返回 guest lease').toMatch(/^[0-9a-f-]{36}$/i)
      expect(reservation.partition, '原生 Browser bridge 必须返回隔离 session partition').toMatch(/^electron-browser-[0-9a-f-]{36}$/i)
    }
    finally {
      await main.evaluate(async (lease) => {
        const bridge = (window as Window & { dshDesktop?: { browser?: { release: (lease: string) => Promise<void> } } }).dshDesktop?.browser
        if (!bridge)
          throw new Error('Native Browser bridge disappeared before release')
        await bridge.release(lease)
      }, reservation.lease)
    }
  })

  it.runIf(process.platform !== 'darwin')('keeps the hosted DSH document intact while shell popovers open and close', async () => {
    const shell = app.get()
    const main = shell.window.page
    await installErrorCollector(main)
    const health = await waitHealthy(main)
    const origin = new URL(health.service_url).origin
    let guest: Page | undefined
    await expect.poll(() => {
      guest = shell.browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(`${origin}/`))
      return Boolean(guest)
    }, { timeout: WINDOW_TIMEOUT_MS, message: '健康服务必须对应真实的原生 Harness 页面' }).toBe(true)
    const native = guest!
    await expect.poll(() => native.evaluate(() => document.readyState), { timeout: WINDOW_TIMEOUT_MS, message: '原生 Harness 页面必须完成加载' }).toBe('complete')
    const url = native.url()
    const nonce = randomUUID()
    const viewport = await native.evaluate(async (value) => {
      (window as Window & { __dshE2eMenuNonce?: string }).__dshE2eMenuNonce = value
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { width: innerWidth, height: innerHeight, scale: devicePixelRatio }
    }, nonce)
    expect(viewport.width, '原生页面必须具有真实视口宽度').toBeGreaterThan(100)
    expect(viewport.height, '原生页面必须具有真实视口高度').toBeGreaterThan(100)
    await expect.poll(() => main.locator(NAVBAR_MENU_CONFIG).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '壳层菜单必须可见' }).toBe(true)

    try {
      await main.locator(NAVBAR_MENU_CONFIG).click({ timeout: WINDOW_TIMEOUT_MS })
      await expect.poll(() => main.locator(NAVBAR_MENU_POPOVER).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '必须打开真实的壳层菜单' }).toBe(true)
      await main.locator('[data-testid="dsh-navbar-item-application"]').click()
      await expect.poll(() => main.locator('[data-testid="dsh-config-dialog"]').isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '点击 Application 菜单项必须打开设置对话框' }).toBe(true)
      expect(main.url().startsWith(origin), '打开壳层菜单不得把主窗口导航走').toBe(true)
      await main.locator('[data-testid="dsh-config-dialog-close"]').click()
      await expect.poll(() => main.locator('[data-testid="dsh-config-dialog"]').isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '关闭设置对话框必须执行实际关闭动作' }).toBe(false)
    }
    finally {
      await main.keyboard.press('Escape')
    }
    await expect.poll(() => main.locator(NAVBAR_MENU_POPOVER).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: 'Escape 必须关闭壳层菜单' }).toBe(false)
    expect(native.url(), '菜单开关不得导航原生页面').toBe(url)
    const preservedNonce = await native.evaluate(() => {
      const host = window as Window & { __dshE2eMenuNonce?: string }
      const value = host.__dshE2eMenuNonce
      delete host.__dshE2eMenuNonce
      return value
    })
    expect(preservedNonce, '菜单开关不得重载或替换原生页面').toBe(nonce)
    expect(await pageErrors(main), '菜单开关不应产生壳层页面异常').toEqual([])
  })

  it('reloads the hosted page from the config panel without restarting the core service', async () => {
    const shell = app.get()
    const main = shell.window.page
    await main.context().addInitScript(collectPageErrors)
    const health = await waitHealthy(main)
    const corePid = (await invoke<{ pid: number, kind: string }[]>(main, 'get_task_manager_processes')).find(process => process.kind === 'harness')?.pid
    expect(corePid, '刷新前必须能读到本应用托管的核心进程').toBeTruthy()

    if (process.platform === 'darwin') {
      await invoke(main, 'plugin:event|emit_to', { target: { kind: 'Window', label: MAIN_LABEL }, event: 'macos-menu-action', payload: 'desktop-config' })
    }
    else {
      await main.locator(NAVBAR_MENU_CONFIG).click({ timeout: WINDOW_TIMEOUT_MS })
      await main.locator('[data-testid="dsh-navbar-item-application"]').click({ timeout: WINDOW_TIMEOUT_MS })
    }
    await main.locator(CONFIG_DIALOG).waitFor({ state: 'visible', timeout: WINDOW_TIMEOUT_MS })

    await main.evaluate((value) => {
      (window as Window & { __dshE2eReloadNonce?: string }).__dshE2eReloadNonce = value
    }, randomUUID())
    await main.locator(CONFIG_RELOAD_PAGE).click({ noWaitAfter: true, timeout: WINDOW_TIMEOUT_MS })

    // 旧窗口文档被整个换掉时它的全局变量随之消失；只推进 webviewKey 的重挂不会走到这里。
    await expect.poll(async () => {
      try {
        return await main.evaluate(() => Boolean((window as Window & { __dshE2eReloadNonce?: string }).__dshE2eReloadNonce))
      }
      catch {
        return false
      }
    }, { timeout: WINDOW_TIMEOUT_MS, message: '刷新页面必须真正重新加载当前文档，而不是只切换壳层状态' }).toBe(false)

    const reloaded = await waitHealthy(main)
    expect(reloaded.service_url, '刷新页面不得更换核心服务地址').toBe(health.service_url)
    expect((await invoke<{ pid: number, kind: string }[]>(main, 'get_task_manager_processes')).find(process => process.kind === 'harness')?.pid, '刷新页面不得重启核心进程').toBe(corePid)
    expect(await pageErrors(main), '刷新页面不应产生页面异常').toEqual([])
  })

  it('reloads the hosted page on F5 without restarting the core service', async () => {
    const shell = app.get()
    const main = shell.window.page
    await main.context().addInitScript(collectPageErrors)
    const health = await waitHealthy(main)
    const corePid = (await invoke<{ pid: number, kind: string }[]>(main, 'get_task_manager_processes')).find(process => process.kind === 'harness')?.pid
    expect(corePid, '刷新前必须能读到本应用托管的核心进程').toBeTruthy()
    await expect.poll(() => main.locator(SHELL_ROOT).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: 'F5 必须由壳层接管，先等首屏渲染完成' }).toBe(true)

    await main.evaluate((value) => {
      (window as Window & { __dshE2eReloadNonce?: string }).__dshE2eReloadNonce = value
    }, randomUUID())
    await main.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await main.keyboard.press('F5')

    // 与配置面板按钮同一条路径：文档被整个换掉，只推进 webviewKey 的重挂不会走到这里。
    await expect.poll(async () => {
      try {
        return await main.evaluate(() => Boolean((window as Window & { __dshE2eReloadNonce?: string }).__dshE2eReloadNonce))
      }
      catch {
        return false
      }
    }, { timeout: WINDOW_TIMEOUT_MS, message: 'F5 必须真正重新加载当前文档，而不是只切换壳层状态' }).toBe(false)

    const reloaded = await waitHealthy(main)
    expect(reloaded.service_url, 'F5 刷新不得更换核心服务地址').toBe(health.service_url)
    expect((await invoke<{ pid: number, kind: string }[]>(main, 'get_task_manager_processes')).find(process => process.kind === 'harness')?.pid, 'F5 刷新不得重启核心进程').toBe(corePid)
    expect(await pageErrors(main), 'F5 刷新不应产生页面异常').toEqual([])
  })
})
