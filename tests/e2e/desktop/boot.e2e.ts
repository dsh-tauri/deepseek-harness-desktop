import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, collectPageErrors, completePreinstall, HARNESS_WEBVIEW, installErrorCollector, invoke, NAVBAR_MENU_CONFIG, NAVBAR_MENU_POPOVER, pageErrors, SHELL_ROOT, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

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
}

const app = shellAppScope()

beforeAll(async () => {
  await completePreinstall(app.get().window.page, ASSEMBLY_TIMEOUT_MS)
}, ASSEMBLY_TIMEOUT_MS)

/**
 * 等 Harness 真正就绪：跟随壳记录的服务地址，再看那个地址上是否已经有启动完成的
 * 原生页面（`__DSH_BOOT__` 由壳注入，客户端模块清单就在里面）。
 *
 * 此前这里直接轮询 `proxy_health_check`：那是一条会并发探测 90+ 个 bundle 的完整门禁，
 * 在 30 秒窗口里跑完属于「环境够快才过」，Windows 上偶发超时（issue #1384）。就绪信号
 * 本身没变——服务在监听、boot 清单在盘、页面已启动——只是按真实信号等待，而不是拿
 * 一个固定窗口去赌探测轮次。核心进程退出仍立刻失败，不会把崩溃耗成超时。
 */
async function waitHealthy(page: Page): Promise<HealthCheck> {
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
    const prefix = `${new URL(serviceUrl).origin}/`
    const pages = app.get().browser.contexts().flatMap(context => context.pages())
    // 就绪判据取产品自身那条门禁：客户端模块全部可取即已就绪。它比「页面已加载」
    // 更严格，也才是壳与 Core 共同认可的信号；跑在 CDP 侧并发探测，不占固定窗口。
    const guests = pages.filter(candidate => candidate.url().startsWith(prefix) && !candidate.isClosed())
    if (guests.length === 0)
      return false
    for (const guest of guests) {
      const ready = await guest.evaluate(async () => {
        const boot = (globalThis as { __DSH_BOOT__?: { entries?: Array<{ url?: string }> } }).__DSH_BOOT__
        if (document.readyState !== 'complete' || !Array.isArray(boot?.entries))
          return false
        const urls = boot.entries.map(entry => entry.url).filter((url): url is string => typeof url === 'string' && url.length > 0)
        if (urls.length === 0)
          return true
        const results = await Promise.all(urls.map(url => fetch(url, { method: 'GET' })
          .then(response => response.ok)
          .catch(() => false)))
        return results.every(Boolean)
      }).catch(() => false)
      if (ready)
        return true
    }
    return false
  }, { timeout: WINDOW_TIMEOUT_MS, message: 'Harness 核心未达到就绪状态' }).toBe(true)
  return { service_url: serviceUrl, status: `healthy - ${new URL(serviceUrl).origin}` }
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
    expect(info.log_path, '运行时必须返回服务日志路径').toContain(shell.home)
    expect(info.platform, '运行时必须返回平台').toBe(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')
    expect(info.arch, '运行时必须返回架构').toBeTruthy()
    expect(await pageErrors(shell.window.page), '启动过程不应产生页面异常').toEqual([])
  })

  it('exposes the host path bridge to the Harness page', async () => {
    const shell = app.get()
    const health = await waitHealthy(shell.window.page)
    const origin = new URL(health.service_url).origin
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

  it.runIf(process.platform !== 'darwin')('preserves the native Harness backdrop for Windows/Linux shell popovers without reloading', async () => {
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
    const backdrop = main.locator(HARNESS_WEBVIEW).locator('img')
    expect(await backdrop.count(), '菜单打开前不应残留截图背景').toBe(0)

    try {
      await main.locator(NAVBAR_MENU_CONFIG).click({ timeout: WINDOW_TIMEOUT_MS })
      await expect.poll(() => main.locator(NAVBAR_MENU_POPOVER).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '必须打开真实的壳层菜单' }).toBe(true)
      await expect.poll(() => backdrop.count(), { timeout: WINDOW_TIMEOUT_MS, message: '菜单打开后必须显示原生页面截图' }).toBe(1)
      await expect.poll(() => backdrop.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0), { timeout: WINDOW_TIMEOUT_MS, message: '截图必须完成图片解码' }).toBe(true)
      const capture = await backdrop.evaluate((element) => {
        const image = element as HTMLImageElement
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const colors = new Set<string>()
        let nonWhitePixels = 0
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] === 0)
            continue
          colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`)
          if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 250)
            nonWhitePixels++
        }
        return { width: image.naturalWidth, height: image.naturalHeight, colors: colors.size, nonWhitePixels }
      })
      expect(capture.width / viewport.width, '截图宽度必须覆盖真实视口，不能是 1×1 占位图').toBeGreaterThanOrEqual(0.9)
      expect(capture.height / viewport.height, '截图高度必须覆盖真实视口，不能是 1×1 占位图').toBeGreaterThanOrEqual(0.9)
      expect(capture.width / viewport.width, '截图宽度必须符合视口与显示缩放范围').toBeLessThanOrEqual(Math.max(1, viewport.scale) * 1.1)
      expect(capture.height / viewport.height, '截图高度必须符合视口与显示缩放范围').toBeLessThanOrEqual(Math.max(1, viewport.scale) * 1.1)
      expect(Math.abs(capture.width / capture.height - viewport.width / viewport.height), '截图宽高比必须与原生视口一致').toBeLessThan(0.05)
      expect(capture.nonWhitePixels, '截图不能是全白或全透明背景').toBeGreaterThan(0)
      expect(capture.colors, '截图必须包含真实页面的多种颜色').toBeGreaterThan(4)
    }
    finally {
      await main.keyboard.press('Escape')
    }
    await expect.poll(() => main.locator(NAVBAR_MENU_POPOVER).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: 'Escape 必须关闭壳层菜单' }).toBe(false)
    await expect.poll(() => backdrop.count(), { timeout: WINDOW_TIMEOUT_MS, message: '关闭菜单后必须移除截图并恢复原生页面' }).toBe(0)
    expect(native.url(), '菜单开关不得导航原生页面').toBe(url)
    const preservedNonce = await native.evaluate(() => {
      const host = window as Window & { __dshE2eMenuNonce?: string }
      const value = host.__dshE2eMenuNonce
      delete host.__dshE2eMenuNonce
      return value
    })
    expect(preservedNonce, '菜单开关不得重载或替换原生页面').toBe(nonce)
    expect(await pageErrors(main), '菜单截图切换不应产生壳层页面异常').toEqual([])
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
    try {
      const clone = await invoke<{ id: string }>(main, 'clone_profile', {
        sourceId: originalConfig.active_profile,
        name: `e2e-profile-${process.pid}-${Date.now()}`,
      })
      cloneId = clone.id

      second = await shell.openWindow()
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '同档案窗口必须继承发起窗口档案').toBe(originalConfig.active_profile)
      expect((await invoke<RuntimeInfo>(second.page, 'get_runtime_info')).service_url, '同档案窗口必须复用核心服务地址').toBe(originalRuntime.service_url)
      await waitHealthy(second.page)

      await invoke(second.page, 'set_active_profile', { id: cloneId })
      await invoke(second.page, 'launch_harness')
      const clonedRuntime = await waitHealthy(second.page)
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '切换后窗口必须绑定克隆档案').toBe(cloneId)
      expect(clonedRuntime.service_url, '克隆档案必须使用独立核心服务地址').not.toBe(originalRuntime.service_url)

      third = await shell.openWindow('create_app_window', second)
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
    finally {
      try {
        if (third)
          await shell.closeWindow(third.label)
      }
      finally {
        try {
          if (second) {
            try {
              await invoke(second.page, 'set_active_profile', { id: originalConfig.active_profile })
            }
            finally {
              await shell.closeWindow(second.label)
            }
          }
        }
        finally {
          if (cloneId)
            await invoke(main, 'remove_profile', { id: cloneId })
        }
      }
    }
  })
})
