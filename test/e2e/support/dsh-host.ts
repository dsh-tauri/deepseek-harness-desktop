/**
 * test/e2e/support/dsh-host.ts — 插件 L2 E2E 的宿主编排。
 *
 * 目标：把「真实 dsh web 进程 + 真实插件挂载」这件事变成一行 `startDshHost()`。
 * 全程只写本调用独占的 scratch 目录，绝不触碰 ~/.dsh 与 ~/.dsh.dev。
 *
 * 流程：scratch DSH_HOME → 脚手架 profile → 把插件链接进 profile/node_modules
 * → 写 dsh.profile.bundles → dsh web --port 0 → 从日志解析就绪 URL。
 *
 * 挂载方式由 DSH_E2E_MOUNT 选择：
 *   link（默认）：自建目录链接，离线、快，不碰 pnpm store；
 *   cli：走真实 `dsh plugin --profile web add link:<pkg>`（需要网络与 pnpm）。
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** 仓库根（本文件位于 `<root>/test/e2e/support/`）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** scratch profile 名：与桌面端一致（`dsh web` 默认档案）。 */
const PROFILE = 'web'

/**
 * 就绪行正则：只取 URL 本体（`dsh web: ` 前缀留在匹配之外，否则 `new URL()` 会抛）。
 * 必须吃到空白为止——在 `/` 处截断会丢掉 `?token=`，首屏直接 401。
 */
const READY_RE = /http:\/\/127\.0\.0\.1:\d+[^\s]*/

/** 就绪等待上限（冷启 dsh web + 插件装配）。 */
const READY_TIMEOUT_MS = 120_000

/** 桌面端已装配的 dsh 入口（无 PATH 上的 dsh 时的兜底）。 */
const ASSEMBLED_DSH = join(
  process.env.APPDATA ?? '',
  'io.github.hairyf.deepseek-harness-desktop',
  'dependencies',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)

export interface StartDshHostOptions {
  /** 要挂载的包名，如 `dsh-tauri-pet`。 */
  plugin: string
  /** 额外挂载的包名（依赖插件，如 `dsh-tauri`）。 */
  also?: readonly string[]
  /** 保留 scratch 目录（调试用）。 */
  keepHome?: boolean
}

export interface DshHost {
  /** 带一次性 token 的就绪 URL；`baseUrl` 用于 HTTP 断言。 */
  readonly url: string
  /** 裸 origin（`http://127.0.0.1:<port>`）。 */
  readonly baseUrl: string
  /** 本次调用独占的 DSH_HOME。 */
  readonly home: string
  /** dsh web 的 stdout+stderr 日志文件。 */
  readonly logPath: string
  /** 已挂载的包名（含 base 与 also）。 */
  readonly mounted: readonly string[]
  /** 停止服务并清理 scratch（幂等）。 */
  stop: () => Promise<void>
}

function log(message: string): void {
  process.stderr.write(`[dsh-host] ${message}\n`)
}

/** 解析 dsh 入口：显式环境变量 → PATH 上的 `dsh` → 桌面端已装配的 bin.js。 */
function resolveDshCommand(): string[] {
  const explicit = process.env.DSH_E2E_DSH_BIN
  if (explicit !== undefined && explicit !== '')
    return [explicit]

  try {
    return [require.resolve('@deepseek-ai/dsh/lib/bin.js')]
  }
  catch {
    // 仓库没装 @deepseek-ai/dsh（它是运行期下载物，不在 workspace 依赖里）。
  }

  if (existsSync(ASSEMBLED_DSH)) {
    log(`使用桌面端已装配的 dsh：${ASSEMBLED_DSH}`)
    return [ASSEMBLED_DSH]
  }

  throw new Error(
    'DSH_E2E_DSH_BIN 未设置，PATH 与桌面端装配目录都没有 dsh 入口；'
    + '请设置 DSH_E2E_DSH_BIN 指向 @deepseek-ai/dsh 的 lib/bin.js',
  )
}

function resolveNodeBin(): string {
  return process.env.DSH_E2E_NODE_BIN ?? process.execPath
}

/** 读包版本号；读不到返回 `0.0.0`（仅用于日志）。 */
function packageVersion(pkgDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

/**
 * 校验插件已构建：`package.json` 的 `main` / `exports` 指向的产物必须存在。
 *
 * E2E 打的是构建产物而不是 TS 源码（官方「真实入口路径」规则），所以这里显式失败，
 * 而不是让 dsh 在 import 阶段抛一个难读的 ERR_MODULE_NOT_FOUND。
 */
function assertBuilt(pkgDir: string, pkg: string): void {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    main?: string
    exports?: Record<string, unknown>
  }
  const main = manifest.main ?? './dist/index.js'
  const hostEntry = join(pkgDir, main.replace(/^\.\//, ''))
  if (!existsSync(hostEntry)) {
    throw new Error(
      `${pkg} 尚未构建：缺少 ${hostEntry}。先跑一次 \`pnpm build:plugins\`（或 \`pnpm --filter ${pkg} build\`）。`,
    )
  }
  const client = manifest.exports?.['./client']
  const clientEntry = typeof client === 'string'
    ? client
    : (client as { default?: string } | undefined)?.default
  if (clientEntry !== undefined && !existsSync(join(pkgDir, clientEntry.replace(/^\.\//, '')))) {
    throw new Error(`${pkg} 的 client 产物缺失：${clientEntry}；先跑一次 \`pnpm build:plugins\`。`)
  }
}

/** 写 scratch profile 三件套（镜像 dsh 的 profile 模板）。 */
function writeProfile(profileDir: string, bundles: readonly string[]): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  // pnpm 11 的 strict-dep-builds 与 minimumReleaseAge 会拦住 dsh 的传递依赖；
  // 与桌面端 / 社区同一份豁免策略（见 better-sidebar 的 scripts/e2e-common.sh）。
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
    'allowBuilds:',
    '  node-pty: true',
    '  protobufjs: true',
    '',
    'minimumReleaseAgeExclude:',
    "  - '@deepseek-ai/*'",
    "  - 'dsh-tauri*'",
    '',
  ].join('\n'))
}

/** 自建目录链接：把仓库里的插件包接到 profile 的 node_modules 下。 */
function linkPackage(profileDir: string, pkg: string): void {
  const source = join(REPO_ROOT, 'packages', pkg)
  if (!existsSync(source))
    throw new Error(`未找到插件包目录：${source}`)

  const target = join(profileDir, 'node_modules', pkg)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  // junction 对目录链接不需要管理员权限，且在 Windows 上表现稳定。
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 生成读 bundle 列表的辅助：挂载后必须能在 bundles 里看到，缺则立即失败。 */
function readBundles(profileDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  return manifest.dsh?.profile?.bundles ?? []
}

function addBundle(profileDir: string, pkg: string): void {
  const path = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[pkg] = `link:${join(REPO_ROOT, 'packages', pkg)}`
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  bundles.add(pkg)
  manifest.dsh = { profile: { ...manifest.dsh?.profile, bundles: [...bundles] } }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 跑一条子命令，等待结束；非 0 退出即抛错（附输出尾部）。 */
function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const tail = output.split('\n').slice(-20).join('\n')
      reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}：\n${tail}`))
    })
  })
}

/** 走真实 CLI 挂载（需要网络与 pnpm）。 */
async function mountViaCli(profileDir: string, home: string, pkgs: readonly string[]): Promise<void> {
  const [dshBin] = resolveDshCommand()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    // 与桌面端 build_plugin_envs 同源：pnpm 10 只认 npm_config_*，pnpm 11 只认 pnpm_config_*。
    ...(process.env.DSH_E2E_PNPM_STORE_DIR
      ? {
          npm_config_store_dir: process.env.DSH_E2E_PNPM_STORE_DIR,
          pnpm_config_store_dir: process.env.DSH_E2E_PNPM_STORE_DIR,
        }
      : {}),
  }
  for (const pkg of pkgs) {
    await run(resolveNodeBin(), [dshBin, 'plugin', '--profile', PROFILE, 'add', `link:${join(REPO_ROOT, 'packages', pkg)}`], profileDir, env)
  }
}

/** 杀进程树：Windows 用 taskkill /T /F，其余平台先 SIGTERM 再 SIGKILL。 */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null)
    return
  const pid = child.pid
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('close', () => resolvePromise())
      killer.on('error', () => resolvePromise())
    })
    return
  }
  child.kill('SIGTERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500))
  if (child.exitCode === null)
    child.kill('SIGKILL')
}

async function waitForReady(child: ChildProcess, logPath: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`dsh web 提前退出（code ${child.exitCode}）；日志：${logPath}\n${tailOf(logPath)}`)
    const match = READY_RE.exec(readLog(logPath))
    if (match !== null)
      return match[0]
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  throw new Error(`等待 dsh web 就绪超时（${READY_TIMEOUT_MS}ms）；日志：${logPath}\n${tailOf(logPath)}`)
}

function tailOf(path: string, lines = 30): string {
  const text = readLog(path)
  return text === '' ? '(日志为空)' : text.split('\n').slice(-lines).join('\n')
}

/** 读日志全文；子进程还没吐出任何输出时按空处理（首次读发生在文件创建前）。 */
function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

/**
 * 起一个真实 dsh web 宿主并挂载指定插件。
 *
 * 调用方负责 `stop()`（Playwright 用 globalSetup/globalTeardown 保证）。
 */
export async function startDshHost(options: StartDshHostOptions): Promise<DshHost> {
  const { plugin, also = [], keepHome = false } = options
  const packages = [...also, plugin]
  for (const pkg of packages)
    assertBuilt(join(REPO_ROOT, 'packages', pkg), pkg)

  const home = join(tmpdir(), `dsh-e2e-${plugin}-${Date.now().toString(36)}`)
  const profileDir = join(home, 'profiles', PROFILE)
  const logPath = join(home, 'dsh-web.log')
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...packages]

  // 装配期的任何失败都要把 scratch 目录带走，否则 /tmp 里会堆半成品。
  try {
    writeProfile(profileDir, bundles)

    const mode = process.env.DSH_E2E_MOUNT ?? 'link'
    if (mode === 'cli') {
      log(`挂载方式：cli（dsh plugin add）；profile=${profileDir}`)
      await mountViaCli(profileDir, home, packages)
    }
    else {
      log(`挂载方式：link；profile=${profileDir}`)
      for (const pkg of packages) {
        linkPackage(profileDir, pkg)
        addBundle(profileDir, pkg)
      }
    }

    const missing = packages.filter(pkg => !readBundles(profileDir).includes(pkg))
    if (missing.length > 0)
      throw new Error(`挂载未注册到 dsh.profile.bundles：${missing.join(', ')}`)
  }
  catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }

  const [dshBin] = resolveDshCommand()
  // `dsh web` 就是 `--profile web` 的别名，两者不能同时给（CLI 会直接报错退出）；
  // 因此 scratch profile 的目录名固定为 `web`。
  //
  // `--skip-auth`：dsh 的 `/api/**` 浏览器信任围栏默认要求「带一次性 token 换 cookie」，
  // 纯 HTTP 调用（无 cookie jar）会一律 401，分不清「没挂载」和「没鉴权」。桌面端是
  // 内嵌 UI，插件宿主路由本来就是给 Tauri 进程用普通 fetch 调的，所以这里跳过鉴权、
  // 只保留 Host/Origin 围栏——断言才落在「路由存在与否」上。
  const args = [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--skip-auth']
  log(`启动 dsh web（DSH_HOME=${home}）`)
  // 先落一个空日志：就绪轮询可能在子进程吐出任何输出之前就读它。
  writeFileSync(logPath, '')
  const child = spawn(resolveNodeBin(), args, {
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks: string[] = []
  const collect = (chunk: Buffer): void => {
    chunks.push(chunk.toString())
    writeFileSync(logPath, chunks.join(''))
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped)
      return
    stopped = true
    await killTree(child)
    if (!keepHome)
      rmSync(home, { recursive: true, force: true })
    else
      log(`KEEP_HOME：保留 ${home}`)
  }

  try {
    const url = await waitForReady(child, logPath)
    const baseUrl = new URL(url).origin
    log(`就绪：${baseUrl}（已挂载 ${packages.join(', ')}；${plugin}@${packageVersion(join(REPO_ROOT, 'packages', plugin))}）`)
    return { url, baseUrl, home, logPath, mounted: packages, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}
