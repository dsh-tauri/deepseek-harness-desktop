import type { Page, Request, Response } from 'playwright'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, collectPageErrors, completePreinstall, diagnose, installErrorCollector, invoke, NAVBAR_MENU_CONFIG, NAVBAR_MENU_POPOVER, pageErrors, SHELL_ROOT, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

interface RuntimeInfo {
  app_version: string
  node_version: string
  service_url: string
  data_dir: string
  log_path: string
  platform: string
  arch: string
}

interface AppConfig {
  active_profile: string
}

interface HealthCheck {
  status: string
  service_url: string
  boot_html?: string
}

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

/**
 * 等 Harness 真正就绪：先确认本窗口仍持有核心，再走产品自身的那条门禁
 * （`proxy_health_check` 同时验证服务在监听与客户端模块都可取）。
 *
 * 就绪判据只能有一条：E2E 自造的判据（页面加载完、能取到 bundle）与产品实际
 * 认可的时机不同，切换档案、复用核心时会把「还没就绪」认成「已就绪」（issue #1384）。
 * 这里只做一件事——核心进程已退出时立刻失败，不把崩溃耗成超时。
 */
async function waitHealthy(page: Page): Promise<HealthCheck> {
  let documentState: { protocol: string, readyState: DocumentReadyState } | undefined
  await expect.poll(async () => {
    try {
      documentState = await page.evaluate(() => ({ protocol: location.protocol, readyState: document.readyState }))
    }
    catch (error) {
      if (String(error).includes('Execution context was destroyed, most likely because of a navigation'))
        return false
      throw error
    }
    return documentState.protocol === 'chrome-error:' || documentState.readyState === 'complete'
  }, { timeout: WINDOW_TIMEOUT_MS, message: '顶层 Harness 文档必须完成加载后才能调用原生命令' }).toBe(true)
  if (documentState?.protocol === 'chrome-error:')
    throw new Error('Harness 顶层导航进入 chrome-error，禁止继续等待原生命令')
  expect(documentState?.readyState, '顶层 Harness 文档必须完成加载后才能调用原生命令').toBe('complete')
  let serviceUrl = ''
  await expect.poll(async () => {
    const info = await invoke<RuntimeInfo>(page, 'get_runtime_info')
    serviceUrl = info.service_url
    try {
      await invoke(page, 'harness_ownership')
    }
    catch (error) {
      if (String(error).includes('HARNESS_NOT_OWNED'))
        throw new Error(`Harness 核心已退出：${String(error)}`)
    }
    // 就绪判据沿用产品自身那条门禁：它同时验证「服务在监听」与「客户端模块都可取」，
    // 是壳与 Core 共同认可的信号。核心进程退出已在上面快速失败，不会耗成超时。
    const health = await invoke<HealthCheck>(page, 'proxy_health_check')
    return health.status.startsWith('healthy')
  }, { timeout: WINDOW_TIMEOUT_MS, message: 'Harness 核心未达到就绪状态' }).toBe(true)
  const origin = new URL(serviceUrl).origin
  await expect.poll(() => new URL(page.url()).origin, { timeout: WINDOW_TIMEOUT_MS, message: '产品必须自行导航至所属核心文档' }).toBe(origin)
  await page.locator('div[class$="_frame"]').waitFor({ state: 'visible', timeout: WINDOW_TIMEOUT_MS })
  return { service_url: serviceUrl, status: `healthy - ${origin}` }
}

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

  it('reuses same-profile cores and isolates cloned-profile windows', async () => {
    const shell = app.get()
    const main = shell.window.page
    await waitHealthy(main)
    const originalConfig = await invoke<AppConfig>(main, 'get_app_config')
    const originalRuntime = await invoke<RuntimeInfo>(main, 'get_runtime_info')

    let cloneId: string | undefined
    let second: Awaited<ReturnType<typeof shell.openWindow>> | undefined
    let third: Awaited<ReturnType<typeof shell.openWindow>> | undefined
    const failures: unknown[] = []
    const networkFailures: object[] = []
    const observed = new WeakSet<Page>()
    const detach: Array<() => void> = []
    let stage = 'clone-profile'
    function observePage(page: Page) {
      if (observed.has(page))
        return
      observed.add(page)
      function record(request: Request, error: string) {
        const resource = new URL(request.url())
        const document = new URL(page.url() || 'about:blank')
        if (networkFailures.length === 32)
          networkFailures.shift()
        networkFailures.push({ time: Date.now(), stage, document: (document.origin + document.pathname).slice(0, 256), method: request.method(), resource: (resource.origin + resource.pathname).slice(0, 256), type: request.resourceType(), error })
      }
      function failed(request: Request) {
        record(request, request.failure()?.errorText ?? 'requestfailed')
      }
      function received(response: Response) {
        if (response.status() >= 400)
          record(response.request(), `HTTP ${response.status()}`)
      }
      page.on('requestfailed', failed)
      page.on('response', received)
      detach.push(() => {
        page.off('requestfailed', failed)
        page.off('response', received)
      })
    }
    for (const context of shell.browser.contexts()) {
      context.on('page', observePage)
      detach.push(() => context.off('page', observePage))
      context.pages().forEach(observePage)
    }
    try {
      const clone = await invoke<{ id: string }>(main, 'clone_profile', {
        sourceId: originalConfig.active_profile,
        name: `e2e-profile-${process.pid}-${Date.now()}`,
      })
      cloneId = clone.id

      stage = 'second-initial'
      second = await shell.openWindow()
      observePage(second.page)
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '同档案窗口必须继承发起窗口档案').toBe(originalConfig.active_profile)
      expect((await invoke<RuntimeInfo>(second.page, 'get_runtime_info')).service_url, '同档案窗口必须复用核心服务地址').toBe(originalRuntime.service_url)
      await waitHealthy(second.page)

      stage = 'second-clone'
      await invoke(second.page, 'set_active_profile', { id: cloneId })
      await invoke(second.page, 'launch_harness')
      await expect.poll(async () => (await invoke<HealthCheck>(second!.page, 'proxy_health_check')).status.startsWith('healthy'), { timeout: WINDOW_TIMEOUT_MS }).toBe(true)
      const targetRuntime = await invoke<RuntimeInfo>(second.page, 'get_runtime_info')
      await invoke(second.page, 'host_harness_document', { url: targetRuntime.service_url })
      const clonedRuntime = await waitHealthy(second.page)
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '切换后窗口必须绑定克隆档案').toBe(cloneId)
      expect(clonedRuntime.service_url, '克隆档案必须使用独立核心服务地址').not.toBe(originalRuntime.service_url)

      stage = 'third-clone'
      third = await shell.openWindow('create_app_window', second)
      observePage(third.page)
      expect((await invoke<AppConfig>(third.page, 'get_app_config')).active_profile, '克隆档案窗口必须继承克隆档案').toBe(cloneId)
      expect((await invoke<RuntimeInfo>(third.page, 'get_runtime_info')).service_url, '克隆档案窗口必须复用克隆核心').toBe(clonedRuntime.service_url)
      await waitHealthy(third.page)

      await shell.closeWindow(third.label)
      third = undefined
      await waitHealthy(second.page)

      await shell.closeWindow(second.label)
      second = undefined
      expect((await waitHealthy(main)).service_url, '关闭克隆档案窗口不得影响原档案核心').toBe(originalRuntime.service_url)
    }
    catch (error) {
      console.error('[profile-client-load]', { stage, networkFailures })
      failures.push(error)
    }
    finally {
      detach.forEach(stop => stop())
      for (const opened of [third, second]) {
        if (!opened)
          continue
        try {
          await shell.closeWindow(opened.label)
        }
        catch (error) {
          failures.push(error)
        }
      }
      if (cloneId) {
        try {
          await expect.poll(
            () => invoke(main, 'remove_profile', { id: cloneId }).then(() => 'removed', error => String(error)),
            { timeout: WINDOW_TIMEOUT_MS, message: '关闭克隆档案窗口后其档案应可删除' },
          ).toBe('removed')
        }
        catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, '档案窗口生命周期失败（首项为原始异常）')
  })
})
