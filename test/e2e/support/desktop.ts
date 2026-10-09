import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { cleanupWdioSession, createTauriCapabilities, startWdioSession } from '@wdio/tauri-service'

// ============================================================================
// 常量定义
// ============================================================================

/** 仓库根（本文件位于 `<root>/test/e2e/support/`）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Debug 构建的固定端口（`src-tauri/src/config/constants.rs:53`）。 */
export const APP_PORT = 3081

/** 应用主窗口标题（`src-tauri/src/desktop/builder.rs:484`）。 */
export const APP_TITLE = 'DSH Tauri'

/**
 * 主窗口的 webview label，同时也是 WebDriver 的 window handle
 * （`src-tauri/src/desktop/builder.rs` 的 `WebviewWindowBuilder::new(app, "main", ...)`）。
 */
export const MAIN_WEBVIEW = 'main'

/** 残留实例的进程名（与 Cargo 主二进制一致）。 */
const APP_PROCESS_NAME = 'deepseek-harness-desktop'

/** E2E 模式下的 Store 文件名（`config::setting::store_dat_file_name` 的测试分支）。 */
const TEST_STORE_FILE = '.store.test.dat'

/** scratch home 的目录前缀。 */
const SCRATCH_PREFIX = 'dsh-e2e-desktop-'

/** 只清理超过该年龄的残留：足够避开并发会话正在使用的 scratch (30 分钟)。 */
const STALE_HOME_AGE_MS = 30 * 60 * 1000

/** WDIO 会话建立上限。 */
const SESSION_TIMEOUT_MS = 120_000

/** 默认 WebDriver 端口。 */
const DEFAULT_WEBDRIVER_PORT = 4445

/**
 * 解析并校验内嵌 WebDriver 服务端口。
 */
function resolveWebDriverPort(): number {
  const raw = process.env.TAURI_WEBDRIVER_PORT?.trim()
  if (!raw)
    return DEFAULT_WEBDRIVER_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TAURI_WEBDRIVER_PORT 非法：${JSON.stringify(raw)}（需 1–65535 的整数）`)
  }
  return port
}

export const WEBDRIVER_PORT = resolveWebDriverPort()

// ============================================================================
// 类型接口
// ============================================================================

export interface StartDesktopAppOptions {
  /** 覆盖二进制路径（反向用例用它构造「路径不存在」）。 */
  appBinaryPath?: string
  /** 期望二进制存在；`false` 时跳过存在性校验（用于反向用例）。 */
  requireBinary?: boolean
  /** 保留 `$E2E_HOME`（调试用）。 */
  keepHome?: boolean
  /**
   * 覆盖下载缓存根。
   *
   * 默认**复用跨运行的共享缓存**（`$DSH_E2E_DOWNLOAD_CACHE_DIR`，缺省
   * `<os.tmpdir()>/dsh-e2e-download-cache`）：已下好的 Node/dsh 不再每次重下。
   */
  downloadCacheDir?: string
  /**
   * 本次运行使用空缓存：装配必然真的下载并落盘，跑完随 scratch home 一起删除。
   * 等价于 `DSH_E2E_COLD_ASSEMBLY=1`。
   */
  coldCache?: boolean
  /**
   * 复用指定的隔离根（跨重启持久化用例）。
   */
  homeDir?: string
  /** 启动前清理 `<app-data>/.store.test.dat`；复用隔离根（= 重启）时传 `false` 保留 store。 */
  resetStore?: boolean
}

export interface DesktopApp {
  /** 已建立的 WDIO 会话。 */
  readonly browser: WebdriverIO.Browser
  /** 本次运行独占的隔离根。 */
  readonly home: string
  /** 本次运行使用的下载缓存根（装配落盘断言的观察点）。 */
  readonly downloadCacheDir: string
  /** 应用二进制实际路径。 */
  readonly binaryPath: string
  /** 结束会话（幂等）。 */
  readonly stop: (options?: { keepHome?: boolean }) => Promise<void>
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 拉起真实桌面应用并建立 WDIO 会话。
 */
export async function startDesktopApp(options: StartDesktopAppOptions = {}): Promise<DesktopApp> {
  const {
    requireBinary = true,
    keepHome = false,
    resetStore = true,
  } = options

  const binaryPath = options.appBinaryPath ?? defaultBinaryPath()

  if (requireBinary) {
    await assertPreconditions({ binaryPath })
  }

  // 触发后台异步垃圾回收与 Store 重置（非阻塞）
  void purgeStaleHomes()
  const resetStorePromise = resetStore ? resetTestStore() : Promise.resolve()

  const home = options.homeDir ?? makeHome(keepHome)

  // 并行初始化目录与重置 Store
  const coldCache = options.coldCache ?? process.env.DSH_E2E_COLD_ASSEMBLY === '1'
  const cacheDir = options.downloadCacheDir
    ?? (coldCache
      ? join(home, 'download-cache')
      : process.env.DSH_E2E_DOWNLOAD_CACHE_DIR ?? join(tmpdir(), 'dsh-e2e-download-cache'))

  await Promise.all([
    ensureHomeDirs(home),
    mkdir(cacheDir, { recursive: true }),
    resetStorePromise,
  ])

  const profile = join(home, 'home')
  const env: Record<string, string> = {
    USERPROFILE: profile,
    HOME: profile,
    DSH_DOWNLOAD_CACHE_DIR: cacheDir,
    DSH_E2E_WEBVIEW_DATA_DIR: join(home, 'webview2'),
  }

  const capabilities = createTauriCapabilities(binaryPath, {
    driverProvider: 'embedded',
    startTimeout: SESSION_TIMEOUT_MS,
  })

  capabilities['wdio:tauriServiceOptions'] = {
    ...capabilities['wdio:tauriServiceOptions'],
    embeddedPort: WEBDRIVER_PORT,
    env,
    startTimeout: SESSION_TIMEOUT_MS,
  }

  log(`拉起应用：${binaryPath}（E2E_HOME=${home}）`)

  const startedAt = Date.now()
  let browser: WebdriverIO.Browser | undefined
  let stopped = false

  const stop = async (stopOptions: { keepHome?: boolean } = {}): Promise<void> => {
    if (stopped)
      return
    stopped = true

    if (browser !== undefined) {
      try {
        await cleanupWdioSession(browser)
      }
      catch (error) {
        log(`会话清理告警：${(error as Error).message}`)
      }
    }

    // 并行执行孤儿进程清理与端口释放等待，提升收尾效率
    await Promise.all([
      killOrphanHarness(cacheDir),
      waitForPortRelease(WEBDRIVER_PORT, 20),
    ])

    if (keepHome || stopOptions.keepHome) {
      log(`保留 scratch home：${home}`)
      return
    }

    // 带退避重试清理临时隔离目录
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await rm(home, { recursive: true, force: true })
        log(`收尾完成（${Date.now() - startedAt}ms）`)
        return
      }
      catch (error) {
        if (attempt === 3) {
          log(`scratch 未删除（残留 ${home}）：${(error as Error).message}`)
          return
        }
        await sleep(200 * attempt) // 退避等待
      }
    }
  }

  try {
    browser = await startWdioSession(capabilities, { rootDir: REPO_ROOT })
    await focusMainWindow(browser)
    log(`应用就绪（${Date.now() - startedAt}ms）`)
    return { browser, home, downloadCacheDir: cacheDir, binaryPath, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function log(message: string): void {
  process.stderr.write(`[desktop] ${message}\n`)
}

/** 默认二进制路径。 */
export function defaultBinaryPath(): string {
  const exeSuffix = process.platform === 'win32' ? '.exe' : ''
  return join(REPO_ROOT, 'src-tauri', 'target', 'debug', `${APP_PROCESS_NAME}${exeSuffix}`)
}

/** 端口是否已被监听。 */
export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })

    const cleanup = (busy: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(busy)
    }

    socket.setTimeout(1_000)
    socket.once('connect', () => cleanup(true))
    socket.once('timeout', () => cleanup(false))
    socket.once('error', () => cleanup(false))
  })
}

/** 轮询等待指定端口释放（采用指数退避机制）。 */
async function waitForPortRelease(port: number, maxAttempts = 20): Promise<void> {
  let delay = 50
  for (let i = 0; i < maxAttempts; i++) {
    if (!(await isPortBusy(port)))
      return
    await sleep(delay)
    delay = Math.min(delay * 1.5, 300) // 动态退避
  }
}

/** 应用真实 app-data 目录。 */
function getAppDataDir(): string {
  const roaming = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  return join(roaming, 'dsh-tauri')
}

/** 执行 PowerShell 命令的轻量辅助封装。 */
function execPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.once('error', () => resolve(''))
    child.once('close', () => resolve(output))
  })
}

/**
 * 清理本车道遗留的 dsh 服务进程。
 */
async function killOrphanHarness(cacheDir: string): Promise<void> {
  if (process.platform !== 'win32')
    return

  // PowerShell 路径单引号安全转义
  const safePattern = cacheDir.replace(/'/g, '\'\'')
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safePattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  await execPowerShell(script)
}

/**
 * 检查指定二进制路径是否有活动的进程。
 */
async function hasLiveProcess(binaryPath: string): Promise<boolean> {
  if (process.platform !== 'win32')
    return false

  const script = `Get-CimInstance Win32_Process -Filter "Name='${APP_PROCESS_NAME}.exe'" | Select-Object -ExpandProperty ExecutablePath`
  const output = await execPowerShell(script)
  const target = binaryPath.toLowerCase()

  return output
    .split(/\r?\n/)
    .some(line => line.trim().toLowerCase() === target)
}

// ============================================================================
// 前置校验与状态清理
// ============================================================================

/**
 * 前置校验：确保环境就绪（端口/残余进程检查）。
 */
export async function assertPreconditions(options: { port?: number, binaryPath?: string } = {}): Promise<void> {
  const port = options.port ?? APP_PORT
  const binaryPath = options.binaryPath ?? defaultBinaryPath()

  if (!existsSync(binaryPath)) {
    throw new Error(
      `二进制不存在：${binaryPath}；先在 src-tauri/ 下运行 \`tauri build --debug --no-bundle\`（必须带 custom-protocol，否则应用走 devUrl 而不嵌 dist）。`,
    )
  }

  // 并行检测端口与残留进程，缩短校验耗时
  const [appPortBusy, webdriverPortBusy, liveProcess] = await Promise.all([
    isPortBusy(port),
    isPortBusy(WEBDRIVER_PORT),
    hasLiveProcess(binaryPath),
  ])

  if (appPortBusy) {
    throw new Error(`端口 ${port} 已被监听（debug 固定端口）；请先停掉 dev/debug 实例。本校验不自动杀进程。`)
  }

  if (webdriverPortBusy) {
    throw new Error(
      `WebDriver 端口 ${WEBDRIVER_PORT} 已被占用（多半是另一个桌面实例在跑）；此时会话会静默挂到对方的窗口上，必须先释放。本校验不自动杀进程。`,
    )
  }

  if (liveProcess) {
    throw new Error(`检测到残留桌面实例（${binaryPath}）；请先关闭后再跑 E2E。本校验不自动杀进程。`)
  }
}

/** 清空测试 Store（异步）。 */
export async function resetTestStore(): Promise<void> {
  const file = join(getAppDataDir(), TEST_STORE_FILE)
  try {
    await rm(file, { force: true })
  }
  catch {
    // 忽略文件不存在或删除失败
  }
}

let isStaleHomesPurged = false

/**
 * 异步清理历史运行残留的 scratch home（单例非阻塞执行）。
 */
export async function purgeStaleHomes(): Promise<void> {
  if (isStaleHomesPurged)
    return
  isStaleHomesPurged = true

  const root = tmpdir()
  const deadline = Date.now() - STALE_HOME_AGE_MS

  try {
    const entries = await readdir(root)
    const candidates = entries.filter(e => e.startsWith(SCRATCH_PREFIX))

    const removePromises = candidates.map(async (entry) => {
      const targetPath = join(root, entry)
      try {
        const stats = await stat(targetPath)
        if (stats.mtimeMs <= deadline) {
          await rm(targetPath, { recursive: true, force: true })
          return true
        }
      }
      catch {
        // 忽略单个目录异常
      }
      return false
    })

    const results = await Promise.all(removePromises)
    const removedCount = results.filter(Boolean).length

    if (removedCount > 0) {
      log(`清理历史 scratch：${removedCount} 个`)
    }
  }
  catch {
    // 忽略根目录读取异常
  }
}

/** 建隔离根并派生 home 根。 */
function makeHome(keep: boolean): string {
  const home = join(tmpdir(), `${SCRATCH_PREFIX}${Date.now().toString(36)}`)
  if (keep) {
    log(`KEEP_HOME：${home}`)
  }
  return home
}

/** 建立隔离根内的 profile 目录。 */
async function ensureHomeDirs(home: string): Promise<string> {
  const profile = join(home, 'home')
  await Promise.all([
    mkdir(join(profile, 'AppData', 'Local'), { recursive: true }),
    mkdir(join(profile, 'AppData', 'Roaming'), { recursive: true }),
  ])
  return home
}

/** 把会话切到主窗口（webview label `main`）。 */
async function focusMainWindow(browser: WebdriverIO.Browser): Promise<void> {
  await browser.waitUntil(
    async () => {
      const handles = await browser.getWindowHandles()
      return handles.includes(MAIN_WEBVIEW)
    },
    { timeout: 30_000, timeoutMsg: `未找到主窗口 webview：${MAIN_WEBVIEW}` },
  )

  await browser.switchToWindow(MAIN_WEBVIEW)
}
