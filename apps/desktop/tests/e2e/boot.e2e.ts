import type { Page } from 'playwright'
import type { ShellApp, ShellWindow } from './setup/shell'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, installErrorCollector, invoke, pageErrors, SETTLE_MS, SETUP_ERROR, SHELL_ROOT, SHELL_WEBVIEW, shellAppScope } from './setup/shell'

interface RuntimeInfo {
  service_url: string
  node_version: string
  dsh_version: string
  data_dir: string
  log_path: string
}

interface Appearance {
  palette: string
  terminal: boolean
  transparency: boolean
  opacity: number
  blur: boolean
  sidebarOnly: boolean
}

interface AppConfig {
  zoom_factor: number
  appearance: Appearance
  backup_include_credentials: boolean
}

const WINDOW_TIMEOUT_MS = 30_000
const DSH_ROOT_MARK = 'id="root"'

const shell = shellAppScope()
const app = (): ShellApp => shell.get()
const mainPage = (): Page => app().window.page

async function activeProfile(page: Page): Promise<string> {
  const profiles = await invoke<{ id: string, active: boolean }[]>(page, 'get_profiles')
  const active = profiles.find(profile => profile.active)
  expect(active, '当前原生窗口必须有活动档案').toBeDefined()
  return active!.id
}

async function healthy(page: Page): Promise<string> {
  const runtime = await invoke<RuntimeInfo>(page, 'get_runtime_info')
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      const result = await invoke<{ status: string }>(page, 'proxy_health_check')
      if (/^healthy - \d+\/\d+ client modules ready$/.test(result.status))
        return result.status
    }
    catch {}
    const response = await fetch(runtime.service_url, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined)
    if (response?.ok && process.platform === 'win32')
      return `healthy - http ${response.status}`
    if (Date.now() >= deadline)
      throw new Error(`核心未就绪: ${runtime.service_url} ${response?.status ?? 'no response'}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function openWindow(source?: ShellWindow): Promise<ShellWindow> {
  return app().openWindow('create_app_window', source)
}

async function closeWindow(window: ShellWindow): Promise<void> {
  await app().closeWindow(window.label)
}

async function windowByLabel(label: string): Promise<ShellWindow> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    const found = (await app().windows()).find(window => window.label === label)
    if (found)
      return found
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`原生窗口 ${label} 未在 ${WINDOW_TIMEOUT_MS}ms 内出现`)
}

async function waitForWebview(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.locator(SHELL_WEBVIEW).count() > 0)
      return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`壳层未在 ${timeoutMs}ms 内挂载内嵌页面`)
}

async function click(page: Page, testId: string): Promise<void> {
  const target = page.locator(`[data-testid="${testId}"]`)
  await expect.poll(() => target.isEnabled(), { message: `${testId} 未就绪`, timeout: 30_000 }).toBe(true)
  await target.evaluate((element) => {
    if (element instanceof HTMLElement)
      element.click()
  })
}

async function clickSwitch(page: Page, testId: string): Promise<void> {
  const target = page.locator(`[data-testid="${testId}"] input[role="switch"]`)
  await expect.poll(() => target.isEnabled(), { message: `${testId} 开关未就绪`, timeout: 30_000 }).toBe(true)
  await target.evaluate((element) => {
    if (element instanceof HTMLElement)
      element.click()
  })
}

describe('桌面端启动冒烟', () => {
  beforeAll(async () => {
    const page = mainPage()
    await installErrorCollector(page)
    await completePreinstall(page, ASSEMBLY_TIMEOUT_MS)
  }, ASSEMBLY_TIMEOUT_MS)

  it('TC-DSK-L3-01-001 进入下载装配后 dsh 内核启动、页面渲染且无报错', async () => {
    const page = mainPage()
    await waitForWebview(page, ASSEMBLY_TIMEOUT_MS)
    const cacheDir = app().downloadCacheDir
    const dshPath = join(cacheDir, 'dependencies', 'dsh')
    expect(existsSync(dshPath), 'dsh 本体未落盘（装配没走下载）').toBe(true)

    const info = await invoke<RuntimeInfo>(page, 'get_runtime_info')
    expect(info.node_version, '未解析到可用 Node 运行时').not.toBe('')
    expect(info.dsh_version, '冷装配必须实际启动推荐的 rc.4 核心').toBe('0.2.1-rc.4')
    expect(resolve(info.data_dir), '真实核心数据根必须隔离在本次 scratch').toBe(resolve(app().home, 'home', '.dsh.dev'))
    const logRelative = relative(cacheDir, info.log_path)
    expect(isAbsolute(logRelative) || logRelative === '..' || logRelative.startsWith('../') || logRelative.startsWith('..\\'), '真实核心日志不得写入用户运行实例目录').toBe(false)
    expect(info.service_url, '内核未给出服务地址').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const webview = page.locator(SHELL_WEBVIEW)
    expect(await webview.count(), '壳层未挂载内嵌页面（内核未就绪）').toBe(1)
    expect(await webview.getAttribute('src'), '内嵌页面未指向内核服务地址').toContain(info.service_url)

    expect(await page.locator(SHELL_ROOT).count(), '壳层根节点缺失').toBe(1)
    expect(await page.locator(SETUP_ERROR).count(), '壳层停在装配失败页').toBe(0)

    const response = await fetch(new URL('/', info.service_url), { signal: AbortSignal.timeout(10_000) })
    expect(response.status, '内核服务未返回页面').toBe(200)
    expect(await response.text(), '内核返回的页面缺少 dsh 挂载点').toContain(DSH_ROOT_MARK)

    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    expect(await pageErrors(page), 'dsh 页面出现报错').toEqual([])
  }, ASSEMBLY_TIMEOUT_MS)

  it('TC-DSK-L3-993 原生窗口继承档案、复用同档案核心且切换与关闭不重启其他核心', async () => {
    const page = mainPage()
    const opened: ShellWindow[] = []
    let clonedProfile: string | undefined
    let switchedProfile = false

    const originalProfile = await activeProfile(page)
    const originalRuntime = await invoke<RuntimeInfo>(page, 'get_runtime_info')
    expect(await healthy(page), '原窗口核心必须已就绪').toMatch(/^healthy - /)
    const profilesRoot = join(originalRuntime.data_dir, 'profiles')
    const originalMarkerPath = join(profilesRoot, originalProfile, '.harness.pid')
    const originalMarker = readFileSync(originalMarkerPath, 'utf8')

    try {
      const clone = await invoke<{ id: string }>(page, 'clone_profile', { sourceId: originalProfile, name: 'native-window-993' })
      clonedProfile = clone.id
      const second = await openWindow()
      opened.push(second)
      await expect.poll(() => second.page.locator(SHELL_ROOT).count(), { message: '新窗口壳层根节点缺失', timeout: WINDOW_TIMEOUT_MS }).toBe(1)
      expect(await activeProfile(second.page), '新窗口必须继承发起窗口档案').toBe(originalProfile)
      expect((await invoke<RuntimeInfo>(second.page, 'get_runtime_info')).service_url, '同档案新窗口必须复用服务端口').toBe(originalRuntime.service_url)

      await invoke(second.page, 'set_active_profile', { id: clone.id })
      switchedProfile = true
      await invoke(second.page, 'launch_harness')
      await expect.poll(async () => {
        const status = await invoke<{ status: string }>(second.page, 'proxy_health_check').then(value => value.status, (error: unknown) => {
          if (String(error).startsWith('HARNESS_NOT_READY:'))
            return ''
          throw error
        })
        return status.startsWith('healthy - ')
      }, { message: '第二档案核心未就绪', timeout: ASSEMBLY_TIMEOUT_MS }).toBe(true)

      expect(await activeProfile(second.page), '切换应只改变第二窗口档案').toBe(clone.id)
      const secondRuntime = await invoke<RuntimeInfo>(second.page, 'get_runtime_info')
      expect(secondRuntime.service_url, '不同档案必须使用独立服务端口').not.toBe(originalRuntime.service_url)
      const clonedMarkerPath = join(profilesRoot, clone.id, '.harness.pid')
      const clonedMarker = readFileSync(clonedMarkerPath, 'utf8')
      expect(clonedMarker.split('\n')[0], '不同档案必须持有不同核心进程').not.toBe(originalMarker.split('\n')[0])

      const third = await openWindow(second)
      opened.push(third)
      await invoke(third.page, 'launch_harness')
      expect(await activeProfile(third.page), '第三窗口必须继承第二窗口档案').toBe(clone.id)
      expect((await invoke<RuntimeInfo>(third.page, 'get_runtime_info')).service_url, '第二档案的窗口必须复用核心端口').toBe(secondRuntime.service_url)
      expect(readFileSync(clonedMarkerPath, 'utf8'), '同档案新窗口不得重启已有核心').toBe(clonedMarker)

      expect(await activeProfile(page), '其他窗口切档案不得改变原窗口档案').toBe(originalProfile)
      expect((await invoke<RuntimeInfo>(page, 'get_runtime_info')).service_url, '其他窗口切档案不得改变原核心端口').toBe(originalRuntime.service_url)
      expect(readFileSync(originalMarkerPath, 'utf8'), '其他窗口切档案不得重启原核心').toBe(originalMarker)
      expect(await healthy(page), '第二档案启动后原核心必须仍健康').toMatch(/^healthy - /)

      await closeWindow(third)
      await expect.poll(async () => (await app().windows()).some(window => window.label === third.label), { message: '第三窗口未销毁', timeout: WINDOW_TIMEOUT_MS }).toBe(false)
      expect(await healthy(second.page), '关闭同档案的非最后窗口不得停止核心').toMatch(/^healthy - /)

      await closeWindow(second)
      await expect.poll(async () => (await app().windows()).some(window => window.label === second.label), { message: '第二窗口未销毁', timeout: WINDOW_TIMEOUT_MS }).toBe(false)
      await expect.poll(() => existsSync(clonedMarkerPath), { message: '关闭档案最后窗口后核心 PID 标记未回收', timeout: WINDOW_TIMEOUT_MS }).toBe(false)
      expect(readFileSync(originalMarkerPath, 'utf8'), '关闭其他档案窗口不得重启原核心').toBe(originalMarker)
      expect(await healthy(page), '关闭其他档案最后窗口后原核心必须仍健康').toMatch(/^healthy - /)
    }
    catch (error) {
      console.error('TC-993 primary failure', error, app().output().split(/\r?\n/).filter(line => /window|harness|stop|release|profile|WARN|ERROR|pid/i.test(line)).slice(-80).join(String.fromCharCode(10)))
      throw error
    }
    finally {
      for (const window of opened.reverse()) {
        if ((await app().windows()).some(entry => entry.label === window.label))
          await closeWindow(window)
      }
      await windowByLabel(app().window.label)
      if (switchedProfile)
        await invoke(page, 'set_active_profile', { id: originalProfile })
      if (clonedProfile) {
        await expect.poll(() => existsSync(join(profilesRoot, clonedProfile!, '.harness.pid')), { message: '测试档案核心未完成关闭回收', timeout: WINDOW_TIMEOUT_MS }).toBe(false)
        await invoke(page, 'remove_profile', { id: clonedProfile })
      }
    }
  }, ASSEMBLY_TIMEOUT_MS)

  it('persists appearance through the native bridge and restores defaults', async () => {
    const page = mainPage()
    expect(await page.evaluate(() => (globalThis as unknown as { __DSH_STORE_FILE__: string }).__DSH_STORE_FILE__), '前端必须使用原生测试配置文件').toBe('.store.test.dat')

    const config = async (): Promise<AppConfig> => invoke<AppConfig>(page, 'get_app_config')
    const appearance = async (): Promise<Appearance> => (await config()).appearance

    await click(page, 'dsh-navbar-menu-config')
    await click(page, 'dsh-navbar-item-appearance')
    await click(page, 'dsh-appearance-palette')
    await click(page, 'dsh-appearance-palette-nord')
    await expect.poll(async () => (await appearance()).palette, { message: '原生设置未保存 Nord 配色' }).toBe('nord')

    await clickSwitch(page, 'dsh-appearance-terminal')
    await expect.poll(async () => (await appearance()).terminal, { message: '终端开关未通过原生桥保存' }).toBe(true)

    await clickSwitch(page, 'dsh-appearance-transparency')
    await expect.poll(async () => (await appearance()).transparency, { message: '透明开关未通过原生桥保存' }).toBe(true)
    expect(await appearance(), '开启原生透明未应用默认组合').toEqual({ palette: 'nord', terminal: true, transparency: true, opacity: 80, blur: true, sidebarOnly: true })

    const opacity = page.locator('[data-testid="dsh-appearance-opacity"] input[type="range"]')
    await expect.poll(() => opacity.isEnabled(), { message: '不透明度滑块未就绪', timeout: 30_000 }).toBe(true)
    await opacity.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await appearance()).opacity, { message: '原生设置未保存滑块的 79% 不透明度' }).toBe(79)

    await clickSwitch(page, 'dsh-appearance-sidebar-only')
    await expect.poll(async () => (await appearance()).sidebarOnly, { message: '原生设置未保存内容区不透明开关' }).toBe(false)

    await click(page, 'dsh-appearance-zoom')
    await click(page, 'dsh-appearance-zoom-1.2')
    await expect.poll(async () => (await config()).zoom_factor, { message: '本机界面缩放未从外观面板保存' }).toBe(1.2)
    expect(await appearance(), '原生设置与所选外观不一致').toEqual({ palette: 'nord', terminal: true, transparency: true, opacity: 79, blur: true, sidebarOnly: false })

    const storePath = join(app().home, 'app-data', '.store.test.dat')
    await expect.poll(() => existsSync(storePath), { message: '原生 Store 必须真实保存到本次隔离 app-data' }).toBe(true)
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { setting: { zoom_factor: number, appearance: unknown } }
    expect(persisted.setting.appearance, '隔离 Store 中必须存在刚保存的原生外观设置').toEqual(await appearance())
    expect(persisted.setting.zoom_factor, '隔离 Store 中必须存在刚保存的缩放值').toBe(1.2)

    await click(page, 'dsh-appearance-reset')
    await expect.poll(async () => (await appearance()).palette, { message: '原生外观设置未恢复默认值' }).toBe('default')
    expect(await appearance(), '重置未还原完整原生外观设置').toEqual({ palette: 'default', terminal: false, transparency: false, opacity: 100, blur: false, sidebarOnly: false })
    expect((await config()).zoom_factor, '重置未还原本机界面缩放').toBe(1)
    await click(page, 'dsh-config-dialog-close')
  })

  it('persists shell zoom shortcuts without changing other native settings', async () => {
    const page = mainPage()
    const config = async (): Promise<AppConfig> => invoke<AppConfig>(page, 'get_app_config')
    const shortcut = async (key: string): Promise<void> => {
      await page.evaluate((key) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
      }, key)
    }

    const original = await config()
    try {
      await shortcut('0')
      await expect.poll(async () => (await config()).zoom_factor, { message: '缩放重置未写入原生设置' }).toBe(1)
      await shortcut('+')
      await shortcut('+')
      await expect.poll(async () => (await config()).zoom_factor, { message: '连续缩放快捷键未保存到原生设置' }).toBe(1.2)
      const saved = await config()
      expect(saved.appearance, '缩放不应覆盖原生外观设置').toEqual(original.appearance)
      expect(saved.backup_include_credentials, '缩放不应覆盖凭证备份偏好').toBe(original.backup_include_credentials)
    }
    finally {
      await invoke(page, 'update_app_config', { zoomFactor: original.zoom_factor })
    }
  })
})
