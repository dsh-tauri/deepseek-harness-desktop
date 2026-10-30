import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect } from 'vitest'

export const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..')

const BINARIES = [
  'apps/desktop/src-tauri/target/debug/deepseek-harness-desktop.exe',
  'apps/desktop/src-tauri/target/debug/deepseek-harness-desktop',
  'target/debug/deepseek-harness-desktop.exe',
  'target/debug/deepseek-harness-desktop',
]

const SHELL_PAGE = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost|http:\/\/localhost:1420)/

export const MAIN_LABEL = 'main'
export const APP_TITLE = 'DeepSeek Harness'

export const SHELL_ROOT = '[data-testid="dsh-shell-root"]'
export const SHELL_WEBVIEW = '[data-testid="dsh-shell-webview"]'
export const SETUP_ERROR = '[data-testid="dsh-setup-error"]'
export const SETUP_PREINSTALL_SKIP = '[data-testid="dsh-setup-preinstall-skip"]'

/** 冷装配（真实下载 Node + dsh）的等待上限。 */
export const ASSEMBLY_TIMEOUT_MS = 900_000
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
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`主进程已退出（code=${child.exitCode}）：${lastError}
${tail()}`)
    }

    try {
      const targets = await targetsOf(port)
      if (targets.some(target => target.type === 'page' && SHELL_PAGE.test(target.url)))
        return
      lastError = `targets=${JSON.stringify(targets.map(target => target.url))}`
    }
    catch (error) {
      lastError = String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`等待 Electron CDP 就绪超时：${lastError}`)
}

async function windowsOf(browser: Browser): Promise<ShellWindow[]> {
  const windows: ShellWindow[] = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!SHELL_PAGE.test(page.url()))
        continue
      const label = await page.evaluate(() => (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? '').catch(() => '')
      if (label)
        windows.push({ label, page })
    }
  }
  return windows
}

export async function startShellApp(options: { downloadCacheDir?: string } = {}): Promise<ShellApp> {
  const binary = BINARIES.map(candidate => path.join(ROOT, candidate)).find(existsSync)
  expect(binary, `缺少 debug 产物：${BINARIES.join(' 或 ')}；先执行 pnpm --filter dsh-desktop build 与 cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`).toBeTruthy()

  const home = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-desktop-'))
  const appData = path.join(home, 'app-data')
  const downloadCacheDir = options.downloadCacheDir ?? path.join(home, 'download-cache')
  await mkdir(appData, { recursive: true })
  await mkdir(downloadCacheDir, { recursive: true })

  const port = await freePort()
  const child = spawn(binary!, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_E2E_HOME: home,
      DSH_DOWNLOAD_CACHE_DIR: downloadCacheDir,
      APPDATA: path.join(home, 'appdata'),
      HOME: path.join(home, 'home'),
      XDG_CONFIG_HOME: path.join(home, 'appdata'),
      XDG_DATA_HOME: path.join(home, 'appdata'),
      TAURI_WEBDRIVER_PORT: '4445',
      TAURI_RUNTIME_ELECTRON_OWNER: 'dsh-e2e',
      TAURI_RUNTIME_ELECTRON_ARGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  })

  let output = ''
  const collect = (chunk: string | Uint8Array): void => {
    output = (output + chunk.toString()).slice(-60000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  await waitForShellTarget(port, child, () => output)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)

  const context = browser.contexts()[0]
  expect(context, '未获取到 Electron 默认上下文').toBeTruthy()
  const host = context!.pages().find(candidate => SHELL_PAGE.test(candidate.url()))
  expect(host, `未找到壳层渲染页，现有 page：${context!.pages().map(page => page.url()).join(', ')}`).toBeTruthy()

  const shellWindow: ShellWindow = { label: MAIN_LABEL, page: host! }
  async function stop(): Promise<void> {
    await browser.close().catch(() => undefined)
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else
        child.kill('SIGKILL')
      await exited
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  return {
    binary: binary!,
    home,
    downloadCacheDir,
    process: child,
    browser,
    window: shellWindow,
    windows: () => windowsOf(browser),
    openWindow: async (command = 'create_app_window', source = shellWindow) => {
      const before = new Set((await windowsOf(browser)).map(entry => entry.label))
      await source.page.evaluate(cmd => window.__TAURI_INTERNALS__.invoke(cmd), command)
      const deadline = Date.now() + WINDOW_TIMEOUT_MS
      while (Date.now() < deadline) {
        const opened = (await windowsOf(browser)).find(entry => !before.has(entry.label))
        if (opened)
          return opened
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error(`原生窗口未在 ${WINDOW_TIMEOUT_MS}ms 内创建（command=${command}）`)
    },
    closeWindow: async (label: string) => {
      const target = (await windowsOf(browser)).find(entry => entry.label === label)
      if (!target)
        return
      await target.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close')).catch(() => undefined)
      const deadline = Date.now() + WINDOW_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (!(await windowsOf(browser)).some(entry => entry.label === label))
          return
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error(`原生窗口 ${label} 未在 ${WINDOW_TIMEOUT_MS}ms 内关闭`)
    },
    output: () => output,
    stop,
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
  return await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '')
}

/** 若出现预装引导则跳过，直到壳层内嵌页面被拉起。 */
export async function completePreinstall(page: Page, timeoutMs = ASSEMBLY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.locator(SHELL_WEBVIEW).count() > 0)
      return
    const skip = page.locator(SETUP_PREINSTALL_SKIP).first()
    if (await skip.count() > 0 && await skip.isVisible()) {
      await skip.click()
      return
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

  afterAll(async () => {
    await current?.stop()
  })

  return { get: () => current! }
}
