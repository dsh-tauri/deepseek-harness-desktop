import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'

export const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

const BINARIES = [
  'apps/desktop/src-tauri/target/debug/deepseek-harness-desktop.exe',
  'apps/desktop/src-tauri/target/debug/deepseek-harness-desktop',
  'target/debug/deepseek-harness-desktop.exe',
  'target/debug/deepseek-harness-desktop',
]

export const MAIN_LABEL = 'main'
export const APP_TITLE = 'DeepSeek Harness'

export const SHELL_ROOT = '[data-testid="dsh-shell-root"]'
/**
 * 「壳层已经承载起内部页面」的判据。
 *
 * 生产路径下 DSH 就是主文档本身，没有子视图，就绪标志是 DSH 的主框架
 * `div[class$="_frame"]` 出现；dev 的独立壳层页用 `<webview>` 标签承载，判据是它出现。
 */
export const HARNESS_READY = 'div[class$="_frame"], [data-testid="dsh-harness-webview"]'
/** 壳层 UI 渲染在注入的 Shadow root 内，选择器必须带穿透段。 */
export const SHELL_HOST = '[data-dsh-shell-host]'
export const NAVBAR_MENU_CONFIG = `${SHELL_HOST} >> [data-testid="dsh-navbar-menu-config"]`
export const NAVBAR_MENU_POPOVER = `${SHELL_HOST} >> [data-testid="dsh-navbar-menu-popover"]`
export const NAVBAR_ITEM_PROFILES = '[data-testid="dsh-navbar-item-profiles"]'
export const CONFIG_DIALOG = '[data-testid="dsh-config-dialog"]'
export const CONFIG_DIALOG_TITLE = '[data-testid="dsh-config-dialog-title"]'
export const CONFIG_DIALOG_CLOSE = '[data-testid="dsh-config-dialog-close"]'
export const CONFIG_NAV_APPLICATION = '[data-testid="dsh-config-nav-application"]'
export const PROFILE_MIGRATE_OPEN = '[data-testid="dsh-profile-migrate-open"]'
export const PROFILE_MIGRATE_DIALOG = '[data-testid="dsh-profile-migrate-dialog"]'
export const PROFILE_MIGRATE_CANCEL = '[data-testid="dsh-profile-migrate-cancel"]'
export const SETUP_ERROR = '[data-testid="dsh-setup-error"]'
export const SETUP_PREINSTALL_SKIP = '[data-testid="dsh-setup-preinstall-skip"]'

/** 冷装配（真实下载 Node + dsh）的等待上限。 */
export const ASSEMBLY_TIMEOUT_MS = process.platform === 'darwin' ? 300_000 : 900_000
export const WINDOW_TIMEOUT_MS = 30_000
export const SETTLE_MS = 3_000

export interface ShellWindow {
  label: string
  page: Page
}

export interface ShellApp {
  binary: string
  home: string
  downloadCacheDir: string
  process: ChildProcess
  browser: Browser
  window: ShellWindow
  windows: () => Promise<ShellWindow[]>
  openWindow: (command?: string, source?: ShellWindow) => Promise<ShellWindow>
  closeWindow: (label: string) => Promise<void>
  output: () => string
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
}

async function targetsOf(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
  return await response.json() as CdpTarget[]
}

async function waitForShellTarget(port: number, child: ChildProcess, tail: () => string): Promise<void> {
  const deadline = Date.now() + 120_000
  let lastError = '还没有 CDP target'
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode) {
      throw new Error(`主进程已退出（code=${child.exitCode}）：${lastError}
${tail()}`)
    }

    try {
      const targets = await targetsOf(port)
      if (targets.some(target => target.type === 'page'))
        return
      lastError = `targets=${JSON.stringify(targets.map(target => target.url))}`
    }
    catch (error) {
      lastError = String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`等待 Electron CDP 就绪超时：${lastError}
${tail()}`)
}

async function windowsOf(browser: Browser): Promise<ShellWindow[]> {
  const windows: ShellWindow[] = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const label = await page.evaluate(() => (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? '').catch(() => '')
      if (label)
        windows.push({ label, page })
    }
  }
  return windows
}

async function listTree(root: string, depth: number, lines: string[], prefix = ''): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.slice(0, 40)) {
    lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    if (entry.isDirectory() && depth > 0 && entry.name !== 'node_modules')
      await listTree(path.join(root, entry.name), depth - 1, lines, `${prefix}  `)
  }
}

async function logTails(root: string, depth: number, found: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0 && entry.name !== 'node_modules')
        await logTails(full, depth - 1, found)
    }
    else if (entry.name.endsWith('.log')) {
      found.push(`--- ${full}
${(await readFile(full, 'utf8').catch(() => '')).slice(-6000)}`)
    }
  }
}

export async function diagnose(app: ShellApp): Promise<string> {
  const tree: string[] = []
  await listTree(app.home, 4, tree)
  const logs: string[] = []
  await logTails(app.home, 6, logs)
  await logTails(app.downloadCacheDir, 6, logs)
  const ps = await new Promise<string>((resolve) => {
    const child = spawn('ps', ['-axo', 'pid,ppid,stat,command'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    child.stdout.on('data', chunk => text += chunk.toString())
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(text.split('\n').filter(line => /dsh|node|pnpm|Electron|deepseek/i.test(line)).slice(0, 40).join('\n')))
  })
  return [
    `主进程 exit=${app.process.exitCode} signal=${app.process.signalCode}`,
    '--- 目录',
    tree.join('\n'),
    logs.join('\n'),
    '--- 进程',
    ps,
    '--- 主进程输出',
    app.output(),
  ].join('\n')
}

export async function startShellApp(options: { downloadCacheDir?: string, prepareHome?: (home: string) => Promise<void>, electronArgs?: string[] } = {}): Promise<ShellApp> {
  const candidates = process.env.DSH_E2E_BINARY ? [process.env.DSH_E2E_BINARY] : BINARIES
  const binary = candidates.map(candidate => path.resolve(ROOT, candidate)).find(existsSync)
  expect(binary, `缺少 debug 产物：${candidates.join(' 或 ')}；先执行 pnpm --filter dsh-desktop build 与 cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`).toBeTruthy()

  const home = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-desktop-'))
  const appData = path.join(home, 'app-data')
  const coreRoot = process.env.DSH_E2E_CORE_ROOT
  const downloadCacheDir = options.downloadCacheDir ?? (coreRoot ? path.join(home, 'download-cache') : path.join(ROOT, 'node_modules/.cache/dsh-e2e', process.platform, process.arch))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  let output = ''
  async function stop(): Promise<void> {
    await browser?.close().catch(() => undefined)
    if (child?.pid) {
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) {
          await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000 }).catch((error) => {
            output = (output + String(error)).slice(-60000)
          })
        }
      }
      else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw error
        }
      }
      if (child.exitCode === null && child.signalCode === null)
        await once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  try {
    await mkdir(appData, { recursive: true })
    await mkdir(downloadCacheDir, { recursive: true })
    if (coreRoot && !options.downloadCacheDir)
      await writeFile(path.join(downloadCacheDir, 'dependencies.json'), JSON.stringify({ dsh: path.resolve(coreRoot), pnpm: null, git: null }))
    await mkdir(path.join(home, 'home'), { recursive: true })
    await mkdir(path.join(home, 'appdata'), { recursive: true })
    await mkdir(path.join(home, 'home', 'AppData', 'Roaming'), { recursive: true })
    await mkdir(path.join(home, 'home', 'AppData', 'Local'), { recursive: true })

    await options.prepareHome?.(home)
    const port = await freePort()
    child = spawn(binary!, [], {
      cwd: ROOT,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_E2E_HOME: home,
        DSH_DOWNLOAD_CACHE_DIR: downloadCacheDir,
        APPDATA: path.join(home, 'appdata'),
        LOCALAPPDATA: path.join(home, 'home', 'AppData', 'Local'),
        HOME: path.join(home, 'home'),
        USERPROFILE: path.join(home, 'home'),
        XDG_CONFIG_HOME: path.join(home, 'appdata'),
        XDG_DATA_HOME: path.join(home, 'appdata'),
        XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_STATE_HOME: path.join(home, 'state'),
        TAURI_WEBDRIVER_PORT: '4445',
        TAURI_RUNTIME_ELECTRON_OWNER: path.basename(home),
        TAURI_RUNTIME_ELECTRON_ARGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} ${(options.electronArgs ?? []).join(' ')}`,
      },
    })

    const collect = (chunk: string | Uint8Array): void => {
      output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => collect(String(error)))

    await waitForShellTarget(port, child, () => output)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: WINDOW_TIMEOUT_MS })

    const connected = browser
    const context = connected.contexts()[0]
    expect(context, '未获取到 Electron 默认上下文').toBeTruthy()
    let host: ShellWindow | undefined
    const deadline = Date.now() + WINDOW_TIMEOUT_MS
    while (Date.now() < deadline && !host) {
      host = (await windowsOf(connected)).find(candidate => candidate.label === MAIN_LABEL)
      if (!host)
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    expect(host, 'CDP 页面必须暴露主 Electron 窗口元数据').toBeTruthy()
    const shellWindow: ShellWindow = { label: MAIN_LABEL, page: host!.page }

    return {
      binary: binary!,
      home,
      downloadCacheDir,
      process: child!,
      browser,
      window: shellWindow,
      windows: () => windowsOf(connected),
      openWindow: async (command = 'create_app_window', source = shellWindow) => {
        const before = new Set((await windowsOf(connected)).map(entry => entry.label))
        await source.page.evaluate(cmd => window.__TAURI_INTERNALS__.invoke(cmd), command)
        const deadline = Date.now() + WINDOW_TIMEOUT_MS
        while (Date.now() < deadline) {
          const opened = (await windowsOf(connected)).find(entry => !before.has(entry.label))
          if (opened)
            return opened
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        throw new Error(`原生窗口未在 ${WINDOW_TIMEOUT_MS}ms 内创建（command=${command}）`)
      },
      closeWindow: async (label: string) => {
        let target: ShellWindow | undefined
        await expect.poll(
          async () => {
            target = (await windowsOf(connected)).find(entry => entry.label === label)
            return Boolean(target)
          },
          { timeout: WINDOW_TIMEOUT_MS, message: `原生窗口 ${label} 必须可通过窗口元数据识别` },
        ).toBe(true)
        const controller = (await windowsOf(connected)).find(entry => entry.label !== label)
        expect(controller, `关闭 ${label} 的命令必须由另一个存活窗口发出`).toBeTruthy()
        await controller!.page.evaluate(label => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label }), label)
        await expect.poll(() => target!.page.isClosed(), { timeout: WINDOW_TIMEOUT_MS, message: `原生窗口 ${label} 的 CDP 页面必须销毁` }).toBe(true)
      },
      output: () => output,
      stop,
    }
  }
  catch (error) {
    console.error(`[e2e-startup] ${home}\n${output}`)
    try {
      await stop()
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '桌面启动失败且清理失败')
    }
    throw error
  }
}

/** 在壳层页面里调用一次原生命令，并把结果带回 Node 侧。 */
export function invoke<T>(page: Page, cmd: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ([cmd, args]) => window.__TAURI_INTERNALS__.invoke(cmd as string, args as Record<string, unknown>),
    [cmd, args] as const,
  ) as Promise<T>
}

/** 页面级报错收集器；只装一次，`console.error` 保留原实现。 */
export function collectPageErrors(): void {
  const host = window as Window & { __dshE2eErrors?: string[] }
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

export function readPageErrors(): string[] {
  return (window as Window & { __dshE2eErrors?: string[] }).__dshE2eErrors ?? []
}

export async function installErrorCollector(page: Page): Promise<void> {
  await page.evaluate(collectPageErrors)
}

export async function pageErrors(page: Page): Promise<string[]> {
  return await page.evaluate(readPageErrors) as string[]
}

async function pageText(page: Page): Promise<string> {
  return await page.evaluate(() => (document.body.textContent ?? '').slice(0, 1500)).catch(() => '')
}

/** 若出现预装引导则跳过，直到壳层承载起内部页面。 */
export async function completePreinstall(page: Page, timeoutMs = ASSEMBLY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let dismissed = false
  while (Date.now() < deadline) {
    if (page.isClosed() || page.url().startsWith('chrome-error:'))
      throw new Error(`首次装配页面加载失败：${page.url()}`)
    if (await page.locator(HARNESS_READY).count() > 0)
      return
    const skip = page.locator(SETUP_PREINSTALL_SKIP).first()
    if (!dismissed && await skip.count() > 0 && await skip.isVisible()) {
      await skip.click({ noWaitAfter: true })
      dismissed = true
      continue
    }
    if (await page.locator(SETUP_ERROR).count() > 0)
      throw new Error(`首次装配失败：${await pageText(page)}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`首次装配未完成：既没有出现预装引导，也没有拉起内嵌页面；当前页面：${await pageText(page)}`)
}

/** Registers the shared app for `beforeAll`/`afterAll`; not a React hook. */
export function shellAppScope(options: { downloadCacheDir?: string } = {}): { get: () => ShellApp } {
  let current: ShellApp | undefined

  beforeAll(async () => {
    current = await startShellApp(options)
  }, ASSEMBLY_TIMEOUT_MS * 2)

  afterEach(async (context) => {
    if (current && (context.task.result?.errors?.length ?? 0) > 0) {
      console.error(`[e2e-diagnose] ${context.task.name}
${await diagnose(current)}`)
    }
  })

  afterAll(async () => {
    if (current) {
      await current.stop()
      expect(existsSync(current.home), '测试隔离目录必须随应用停止而删除').toBe(false)
      current = undefined
    }
  })

  return { get: () => current! }
}
