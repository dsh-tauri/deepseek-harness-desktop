/**
 * test/e2e/support/desktop-host.ts — L3 桌面端 E2E 的宿主编排。
 *
 * 目标：把「真实 Debug 二进制 + WDIO 会话」变成一行 `startDesktopApp()`。
 *
 * 与插件 L2 的 `dsh-host.ts` 的关键区别：应用由 `@wdio/tauri-service` 的 embedded
 * provider 自己 spawn（它注入 `TAURI_WEBDRIVER_PORT` 并轮询应用内嵌的 WebDriver server），
 * 本文件只负责前置校验、环境隔离与收尾。
 *
 * 隔离：数据目录由 debug 构建的 `get_dsh_data_path()` 决定，它读 `USERPROFILE`/`HOME`
 * 与 `APPDATA`，并**忽略** `DSH_HOME`（`src-tauri/src/config/runtime.rs:471`）。因此这里
 * 隔离：dsh 数据目录由 `get_dsh_data_path()` 决定，它读 `USERPROFILE`/`HOME` 并
 * **忽略** `DSH_HOME`（`src-tauri/src/config/runtime.rs:471`）；`app_data_dir()` 同源
 * 派生。因此只重定向 home 根即可隔离，绝不写用户真实的 `~/.dsh.dev` 与 Store。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { cleanupWdioSession, createTauriCapabilities, startWdioSession } from '@wdio/tauri-service'

/** 仓库根（本文件位于 `<root>/test/e2e/support/`）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Debug 构建的固定端口（`src-tauri/src/config/constants.rs:53`）。 */
export const APP_PORT = 3081

/** 应用主窗口标题（`src-tauri/src/desktop/builder.rs:484`）。 */
export const APP_TITLE = 'Deepseek Harness Desktop'

/** 残留实例的进程名（按 `productName` 推导）。 */
const APP_PROCESS_NAME = 'deepseek-harness-desktop'

/** E2E 模式下的 Store 文件名（`config::setting::store_dat_file_name` 的测试分支）。 */
const TEST_STORE_FILE = '.store.test.dat'

/**
 * 下载缓存根：跨运行复用，**不随 scratch home 删除**。
 *
 * 环境（Node/pnpm/Git）与核心都装在这里。首次运行会联网下载，之后复用；
 * 想回到「首次装配」状态用 `resetDownloadCache()`。
 */
export const DOWNLOAD_CACHE_DIR = join(tmpdir(), 'dsh-e2e-download-cache')

/** WDIO 会话建立上限。 */
const SESSION_TIMEOUT_MS = 120_000

export interface StartDesktopAppOptions {
  /** 覆盖二进制路径（用例 007 用它构造「路径不存在」）。 */
  appBinaryPath?: string
  /** 期望二进制存在；`false` 时跳过存在性校验（用于反向用例）。 */
  requireBinary?: boolean
  /** 保留 `$E2E_HOME`（调试用）。 */
  keepHome?: boolean
  /**
   * 本次运行禁用自动下载（`DSH_E2E_DISABLE_DOWNLOAD=1`）。
   *
   * 默认不禁用：应用照常走安装/联网核对。只验壳层、不关心装配流程的用例
   * 可置位以省流量；覆盖启动 setup 流程的用例必须保持 `false`。
   */
  disableDownload?: boolean
  /** 覆盖下载缓存根（默认 `DOWNLOAD_CACHE_DIR`）。 */
  downloadCacheDir?: string
}

export interface DesktopApp {
  /** 已建立的 WDIO 会话。 */
  readonly browser: WebdriverIO.Browser
  /** 本次运行独占的隔离根。 */
  readonly home: string
  /** 应用二进制实际路径。 */
  readonly binaryPath: string
  /** 结束会话并清理隔离根（幂等）。 */
  readonly stop: () => Promise<void>
}

/** 默认二进制路径。 */
export function defaultBinaryPath(): string {
  return join(REPO_ROOT, 'src-tauri', 'target', 'debug', `${APP_PROCESS_NAME}${process.platform === 'win32' ? '.exe' : ''}`)
}

function log(message: string): void {
  process.stderr.write(`[desktop-host] ${message}\n`)
}

/** 端口是否已被监听。 */
export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (busy: boolean): void => {
      socket.destroy()
      resolvePromise(busy)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 指定二进制是否仍有存活进程。
 *
 * 按**可执行文件路径**比对，而不是镜像名：用户可能同时装着正式版
 * （如 `G:\Deepseek Harness Desktop\deepseek-harness-desktop.exe`），
 * 按名匹配会把它误判成「测试残留」而拒绝开跑。
 */
async function hasLiveProcess(binaryPath: string): Promise<boolean> {
  if (process.platform !== 'win32')
    return false
  return new Promise((resolvePromise) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='${APP_PROCESS_NAME}.exe'" | `
      + 'Select-Object -ExpandProperty ExecutablePath'
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let output = ''
    child.stdout?.on('data', (chunk: string | Uint8Array) => {
      output += chunk.toString()
    })
    child.once('error', () => resolvePromise(false))
    child.once('close', () => {
      const target = binaryPath.toLowerCase()
      resolvePromise(output.split(/\r?\n/).some(line => line.trim().toLowerCase() === target))
    })
  })
}

/**
 * 前置校验：不满足即 fail，**不自动强杀用户进程**（`desktop.test.md` §6）。
 *
 * 这是测试编排的行为，不是应用行为；用例 008 直接断言本函数的失败语义。
 */
export async function assertPreconditions(options: { port?: number, binaryPath?: string } = {}): Promise<void> {
  const port = options.port ?? APP_PORT
  const binaryPath = options.binaryPath ?? defaultBinaryPath()

  if (!existsSync(binaryPath))
    throw new Error(`二进制不存在：${binaryPath}；先运行 \`cargo build\`（在 src-tauri/ 下）。`)

  if (await isPortBusy(port))
    throw new Error(`端口 ${port} 已被监听（debug 固定端口）；请先停掉 dev/debug 实例。本校验不自动杀进程。`)

  if (await hasLiveProcess(binaryPath))
    throw new Error(`检测到残留桌面实例（${binaryPath}）；请先关闭后再跑 E2E。本校验不自动杀进程。`)
}

/**
 * 建隔离根并派生 home 根。
 *
 * `<home>/AppData/Local` 与 `AppData/Roaming` 必须**预先存在**：`tauri-plugin-http`
 * 的 setup 调 `app_cache_dir()`，解析失败即 `UnknownPath`，应用在 `lib.rs` 的
 * `expect` 处 panic（exit 101）。这条约束是实测得到的。
 */
function makeHome(keep: boolean): string {
  const home = join(tmpdir(), `dsh-e2e-desktop-${Date.now().toString(36)}`)
  const profile = join(home, 'home')
  mkdirSync(join(profile, 'AppData', 'Local'), { recursive: true })
  mkdirSync(join(profile, 'AppData', 'Roaming'), { recursive: true })
  if (keep)
    log(`KEEP_HOME：${home}`)
  return home
}

/** 应用真实 app-data 目录（`SHGetKnownFolderPath` 解析，环境变量改不动它）。 */
function appDataDir(): string {
  const roaming = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  return join(roaming, 'io.github.hairyf.deepseek-harness-desktop')
}

/**
 * 清空测试 Store：应用在 E2E 模式下（`TAURI_WEBDRIVER_PORT` 存在）读写
 * `.store.test.dat`，与用户真实的 `.store.dev.dat` / `.store.dat` 互不相干。
 *
 * 必须在启动前删除：否则会继承上一次运行留下的窗口几何、端口等状态
 * （`01` 批次 TC-004 因此失败过）。只删测试文件，绝不碰另外两份。
 */
export function resetTestStore(): void {
  const file = join(appDataDir(), TEST_STORE_FILE)
  rmSync(file, { force: true })
}

/**
 * 清空下载缓存，回到「首次装配」状态——用于测应用启动的 setup / 装配流程。
 *
 * 只删 E2E 自己的缓存根，绝不碰用户真实 app-data 下的运行时。
 */
export function resetDownloadCache(dir: string = DOWNLOAD_CACHE_DIR): void {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 起一个真实桌面应用并建立 WDIO 会话。
 *
 * 调用方负责 `stop()`；用例的 `eachTest` 或 `afterAll` 必须执行它。
 */
export async function startDesktopApp(options: StartDesktopAppOptions = {}): Promise<DesktopApp> {
  const {
    requireBinary = true,
    keepHome = false,
    disableDownload = false,
    downloadCacheDir = DOWNLOAD_CACHE_DIR,
  } = options

  const binaryPath = options.appBinaryPath ?? defaultBinaryPath()

  if (requireBinary)
    await assertPreconditions({ binaryPath })

  resetTestStore()
  mkdirSync(downloadCacheDir, { recursive: true })
  const home = makeHome(keepHome)

  // 重定向 home 根：`get_dsh_data_path` 读 `USERPROFILE`/`HOME`
  // （`src-tauri/src/config/runtime.rs:455`），`app_data_dir()` 也由 home 派生
  // （`dirs::data_dir()/<identifier>`），因此这一个根同时隔离 dsh 数据与 Store。
  // 下载缓存另由 `DSH_DOWNLOAD_CACHE_DIR` 指向跨运行复用的稳定目录。
  const profile = join(home, 'home')
  const env: Record<string, string> = {
    USERPROFILE: profile,
    HOME: profile,
    DSH_DOWNLOAD_CACHE_DIR: downloadCacheDir,
    ...(disableDownload ? { DSH_E2E_DISABLE_DOWNLOAD: '1' } : {}),
  }

  const capabilities = createTauriCapabilities(binaryPath, {
    driverProvider: 'embedded',
    startTimeout: SESSION_TIMEOUT_MS,
  })
  capabilities['wdio:tauriServiceOptions'] = {
    ...capabilities['wdio:tauriServiceOptions'],
    env,
    startTimeout: SESSION_TIMEOUT_MS,
  }

  log(`拉起应用：${binaryPath}（E2E_HOME=${home}）`)

  let browser: WebdriverIO.Browser | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
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
    if (keepHome)
      return

    // 进程退出后 WebView2 子进程仍会短暂持有缓存文件句柄，直接删会 EBUSY。
    // 先等进程真正消失，再带退避重试删除。
    for (let i = 0; i < 40 && await hasLiveProcess(binaryPath); i++)
      await sleep(250)

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        rmSync(home, { recursive: true, force: true })
        return
      }
      catch (error) {
        if (attempt === 10) {
          // 清理失败不该让已通过的用例变红：留痕但不抛。
          log(`scratch 清理失败（已重试 10 次，残留 ${home}）：${(error as Error).message}`)
          return
        }
        await sleep(500)
      }
    }
  }

  try {
    browser = await startWdioSession(capabilities, { rootDir: REPO_ROOT })
    return { browser, home, binaryPath, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}
