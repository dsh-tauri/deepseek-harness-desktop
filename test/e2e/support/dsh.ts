import type { ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { gte, valid } from 'semver'
import { assertPluginArtifactsCurrent } from './artifacts'

/** 仓库根目录（本文件位于 `<root>/test/e2e/support/`）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** scratch profile 名：与桌面端一致（`dsh web` 默认档案）。 */
const PROFILE = 'web'

/**
 * 就绪行正则：只取 URL 本体（`dsh web: ` 前缀留在匹配之外，否则 `new URL()` 会抛错）。
 * 必须匹配至空白处止——在 `/` 处截断会丢失 `?token=`，导致首屏 401。
 */
const READY_RE = /http:\/\/127\.0\.0\.1:\d\S*/

/** 就绪等待上限（冷启 dsh web + 插件装配）。 */
const READY_TIMEOUT_MS = 120_000

const MINIMUM_CORE_VERSION = '0.2.1-rc.4'

/* ==========================================
 * 类型定义 (Type Definitions)
 * ========================================== */

export interface StartDshHostOptions {
  /** 要挂载的包名，如 `dsh-tauri-pet`。 */
  plugin: string
  /** 额外挂载的包名（依赖插件，如 `dsh-tauri`）。 */
  also?: readonly string[]
  /** 保留 scratch 目录（调试用）。 */
  keepHome?: boolean
}

/** 已就绪的 scratch profile（尚未启动 `dsh web`）。 */
export interface DshProfile {
  /** 本次调用独占的 DSH_HOME。 */
  readonly home: string
  /** profile 目录（`<home>/profiles/web`）。 */
  readonly profileDir: string
  /** 已挂载的包名（含 also）。 */
  readonly packages: readonly string[]
}

export interface DshHost {
  readonly coreVersion: string
  /** 带一次性 token 的就绪 URL；`baseUrl` 用于 HTTP 断言。 */
  readonly url: string
  /** 裸 origin（`http://127.0.0.1:<port>`）。 */
  readonly baseUrl: string
  /** 用就绪 URL 的一次性 token 换来的浏览器会话 Cookie（`name=value`）。 */
  readonly cookie: string
  /** 本次调用独占的 DSH_HOME。 */
  readonly home: string
  /** dsh web 的 stdout+stderr 日志文件。 */
  readonly logPath: string
  /** 已挂载的包名（含 base 与 also）。 */
  readonly mounted: readonly string[]
  /** 停止服务并清理 scratch（幂等）。 */
  stop: () => Promise<void>
}

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

interface PkgManifest {
  version?: string
  main?: string
  exports?: Record<string, unknown>
}

/* ==========================================
 * 通用/基础工具函数 (Utils)
 * ========================================== */

function log(message: string): void {
  process.stderr.write(`[dsh] ${message}\n`)
}

/** node 入口：显式环境变量优先，便于在 CI 里固定解释器。 */
export function resolveNodeBin(): string {
  return process.env.DSH_E2E_NODE_BIN ?? process.execPath
}

/** 通用 JSON 读取，带容错兜底 */
function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  }
  catch {
    return null
  }
}

/** 修改并回写 JSON 文件 */
function updateJson<T>(filePath: string, updater: (data: T) => T): void {
  const data = readJson<T>(filePath) ?? ({} as T)
  const nextData = updater(data)
  writeFileSync(filePath, `${JSON.stringify(nextData, null, 2)}\n`)
}

/** 获取日志尾部文本（用于出错断言输出） */
function tailOf(path: string, lines = 30): string {
  try {
    const text = readFileSync(path, 'utf8')
    if (!text)
      return '(日志为空)'
    return text.split('\n').slice(-lines).join('\n')
  }
  catch {
    return '(无法读取日志)'
  }
}

/* ==========================================
 * 业务逻辑与依赖解析
 * ========================================== */

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))
}

export function resolveDshCommand(): string[] {
  const explicit = process.env.DSH_E2E_DSH_BIN?.trim()
  if (!explicit || !isAbsolute(explicit) || !existsSync(explicit))
    throw new Error('请设置 DSH_E2E_DSH_BIN 为系统临时目录中独立安装的 @deepseek-ai/dsh/lib/bin.js 绝对路径。')
  const dshBin = realpathSync(explicit)
  const tempRoots = [tmpdir(), process.env.RUNNER_TEMP].filter((root): root is string => Boolean(root))
  if (!tempRoots.some(root => isWithin(realpathSync(root), dshBin)) || isWithin(REPO_ROOT, dshBin))
    throw new Error('DSH_E2E_DSH_BIN 必须使用系统临时目录中的独立 CLI，禁止修改用户或运行时核心。')
  const version = coreVersion(dshBin)
  if (!valid(version) || !gte(version, MINIMUM_CORE_VERSION))
    throw new Error(`E2E 核心版本 ${version} 不受支持；最低版本为 ${MINIMUM_CORE_VERSION}。`)
  const expected = process.env.DSH_E2E_CORE_VERSION
  if (expected && version !== expected)
    throw new Error(`E2E 核心版本不匹配：要求 ${expected}，实际 ${version}。`)
  return [dshBin]
}

/** 从 dsh 入口反推核心版本；读不到返回 `unknown`（仅用于日志）。 */
function coreVersion(dshBin: string): string {
  const manifestPath = join(dirname(dirname(dshBin)), 'package.json')
  return readJson<PkgManifest>(manifestPath)?.version ?? 'unknown'
}

export function isolatedDshEnv(home: string): NodeJS.ProcessEnv {
  const userHome = join(home, 'user-home')
  const roaming = join(userHome, 'AppData', 'Roaming')
  const local = join(userHome, 'AppData', 'Local')
  const paths = {
    HOME: userHome,
    USERPROFILE: userHome,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    XDG_CACHE_HOME: join(userHome, '.cache'),
    XDG_DATA_HOME: join(userHome, '.local', 'share'),
    PNPM_HOME: join(local, 'pnpm'),
  }
  for (const path of Object.values(paths))
    mkdirSync(path, { recursive: true })
  const userConfig = join(userHome, '.npmrc')
  if (!existsSync(userConfig))
    writeFileSync(userConfig, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...paths,
    DSH_HOME: home,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_cache: join(userHome, '.npm'),
    COREPACK_HOME: join(local, 'corepack'),
  }
  delete env.DSH_TAURI_EMBEDDED
  delete env.DSH_E2E_HOME
  return env
}

/** 写 scratch profile 三件套（镜像 dsh 的 profile 模板）。 */
function writeProfile(profileDir: string, bundles: readonly string[]): void {
  mkdirSync(profileDir, { recursive: true })

  const profilePkg = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }

  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(profilePkg, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  const workspaceYml = [
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
    '  - \'@deepseek-ai/*\'',
    '  - \'dsh-tauri*\'',
    '',
  ].join('\n')

  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), workspaceYml)
}

/** 自建目录链接：把仓库里的插件包接到 profile 的 node_modules 下。 */
function linkPackage(profileDir: string, pkg: string): void {
  const source = join(REPO_ROOT, 'packages', pkg)
  if (!existsSync(source)) {
    throw new Error(`未找到插件包目录：${source}`)
  }

  const target = join(profileDir, 'node_modules', pkg)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })

  // junction 对目录链接不需要管理员权限，在 Windows 上表现更稳健
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 读取 bundle 列表 */
function readBundles(profileDir: string): string[] {
  return readJson<ProfileManifest>(join(profileDir, 'package.json'))?.dsh?.profile?.bundles ?? []
}

function addBundle(profileDir: string, pkg: string): void {
  const manifestPath = join(profileDir, 'package.json')
  updateJson<ProfileManifest>(manifestPath, (manifest) => {
    const dependencies = manifest.dependencies ?? {}
    dependencies[pkg] = `link:${join(REPO_ROOT, 'packages', pkg)}`

    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    bundles.add(pkg)

    return {
      ...manifest,
      dependencies,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles: Array.from(bundles),
        },
      },
    }
  })
}

/**
 * 挂载自检：`packages` 必须全部登记进 profile 的 `dsh.profile.bundles`
 */
export function assertMountRegistered(profileDir: string, packages: readonly string[]): void {
  const registered = readBundles(profileDir)
  const missing = packages.filter(pkg => !registered.includes(pkg))
  if (missing.length > 0) {
    throw new Error(`挂载未注册到 dsh.profile.bundles：${missing.join(', ')}`)
  }
}

/* ==========================================
 * 核心产物补丁与夹具 (Core patches & fixtures)
 * ========================================== */

/** 核心安装目录下的 renderer 客户端产物包名（`dsh-client-ui-renderer/client` → `lib/client.js`）。 */
const RENDERER_PACKAGE = 'dsh-client-ui-renderer'

/** 核心安装目录下的 conversation 客户端产物包名（composer 补丁的目标）。 */
const CONVERSATION_PACKAGE = 'dsh-client-ui-conversation'

/** 客户端产物末尾的导出锚点；前导缩进由上游打包器决定，必须按实际行读取。 */
const RENDERER_EXPORT_ANCHOR = 'return module.exports;'

/** composer 补丁的语句锚点与标记（与 `src-tauri/src/service/patch/composer.rs` 同源同语义）。 */
const COMPOSER_INERT_ORIGINAL = 'const inert = sessionId === void 0 || hero && chipTitle === void 0;'
const COMPOSER_INERT_PATCHED = 'const inert = sessionId === void 0 || hero && chipTitle === void 0 && cwd === void 0;'
const COMPOSER_PATCH_MARKER = 'dsh-tauri: composer stays usable for a session outside every workspace'
/** 客户端插件探测本能力用的 DOM 标记（与 `dsh-tauri` 适配层的判据逐字一致）。 */
const COMPOSER_CWD_ATTRIBUTE = 'data-dsh-composer-cwd'

/** 技能夹具目录名（kebab-case，符合插件的 `SKILL_NAME_RE`）。 */
const FIXTURE_SKILL_NAME = 'e2e-fixture-skill'

/**
 * 给核心的 renderer 产物补上 `SlotOutlet` 导出（幂等，与
 * `src-tauri/src/service/patch/renderer.rs` 同源同语义）。
 *
 * 官方 `@deepseek-ai/dsh-client-ui-renderer` 只导出 `{apply, inject}`：`SlotOutlet`
 * 实现完整却未公开，桌面壳在启动前就地把活动核心补上这一行（`renderer.rs` 的
 * `apply_at` 明写「E2E 编排复用，无需运行中的桌面端」）。插件车道跑的是裸
 * `dsh web`，没有桌面壳，所以编排必须自己施加同一补丁——CI 的隔离核心是一次干净
 * npm 安装，漏了补丁就会让 `dsh-tauri-ui` 按设计降级：只打一条 console.warn
 * `<SlotOutlet> unavailable (renderer patch missing)`（**不是 error**，所以诊断里的
 * appErrors 为空），随后所有 `dsh-tauri-*` 的座位注入静默 no-op，症状只剩
 * `[data-settings-trigger]` / `[data-slot-sidebar="dsh-tauri-ui"]` 就绪锚点超时。
 *
 * Windows 本地曾因此「假绿」：那里解析到的是桌面端已就地打过补丁的共享装配核心。
 */
function patchRendererSlotOutlet(dshBin: string): void {
  const coreDir = dirname(dirname(dshBin))
  const target = locateCoreClient(coreDir, RENDERER_PACKAGE)

  if (target === undefined)
    throw new Error(`未找到 renderer 客户端产物，无法施加 SlotOutlet 补丁：${coreDir}`)

  const source = readFileSync(target, 'utf8')
  if (source.includes('exports.SlotOutlet'))
    return

  const anchor = source.indexOf(RENDERER_EXPORT_ANCHOR)
  const lineStart = anchor < 0 ? -1 : source.lastIndexOf('\n', anchor) + 1
  const indent = lineStart < 0 ? '' : source.slice(lineStart, anchor)

  if (lineStart < 0 || !/^[\t ]*$/.test(indent))
    throw new Error(`renderer 产物缺少导出锚点 "${RENDERER_EXPORT_ANCHOR}"：${target}`)

  writeFileSync(
    target,
    `${source.slice(0, lineStart)}${indent}exports.SlotOutlet = SlotOutlet;\n${source.slice(lineStart)}`,
  )
  log(`🔧 已给核心 renderer 补上 SlotOutlet 导出：${target}`)
}

/** 核心客户端产物定位：核心自带嵌套依赖 → 安装根提升产物 → Node 子路径解析。 */
function locateCoreClient(coreDir: string, pkg: string): string | undefined {
  const installationRoot = realpathSync(resolve(coreDir, '../../..'))
  if (basename(coreDir) !== 'dsh' || basename(dirname(coreDir)) !== '@deepseek-ai' || basename(dirname(dirname(coreDir))) !== 'node_modules')
    throw new Error(`核心必须来自独立 npm 安装根：${coreDir}`)
  const relPath = join('@deepseek-ai', pkg, 'lib', 'client.js')
  const candidates = [join(coreDir, 'node_modules', relPath), join(dirname(dirname(coreDir)), relPath)]
  let candidate = candidates.find(path => existsSync(path))
  if (candidate === undefined) {
    try {
      candidate = createRequire(join(coreDir, 'package.json')).resolve(`@deepseek-ai/${pkg}/client`)
    }
    catch {
      return undefined
    }
  }
  const target = realpathSync(candidate)
  if (!isWithin(installationRoot, target))
    throw new Error(`核心客户端补丁目标越出独立安装根，拒绝读取或修改：${target}`)
  return target
}

export function patchCoreClients(dshBin: string): void {
  const [isolatedBin] = resolveDshCommand()
  if (realpathSync(dshBin) !== isolatedBin)
    throw new Error('核心补丁入口必须与隔离 CLI 完全一致。')
  patchRendererSlotOutlet(isolatedBin)
  patchComposerCwd(isolatedBin)
}

/**
 * 放宽官方 composer 的 inert 判定并写下能力标记（幂等，与
 * `src-tauri/src/service/patch/composer.rs` 同源同语义）。
 *
 * 官方 `ConversationRoot` 对「不属于任何工作区的空白会话」把 composer 换成「选择工作区」
 * 触发器（`inert` 只看 `chipTitle`，而 `chipTitle` 只来自工作区），`dsh-tauri-ui` 的
 * 「未分组」新会话因此无法输入。插件车道跑的是裸 `dsh web`，没有桌面壳，所以编排必须
 * 自己施加同一补丁——漏了它 `dsh-tauri-ui` 会按退级策略禁用「未分组」入口（console.warn，
 * 不是 error），`data-dsh-composer-cwd` 就绪锚点与未分组用例都会失败。
 */
function patchComposerCwd(dshBin: string): void {
  const coreDir = dirname(dirname(dshBin))
  const target = locateCoreClient(coreDir, CONVERSATION_PACKAGE)

  if (target === undefined)
    throw new Error(`未找到 conversation 客户端产物，无法施加 composer 补丁：${coreDir}`)

  const source = readFileSync(target, 'utf8')
  if (source.includes(COMPOSER_PATCH_MARKER))
    return

  // 优先看原始语句：只要它还在场就放宽它；只有它缺席、放宽形态在场时才算「上游已自修」。
  // 反过来的优先级会让注释里的同形文本把补丁误判成已修，声明了能力却漏放宽。
  const needsRelax = source.includes(COMPOSER_INERT_ORIGINAL)
  const upstreamFixed = !needsRelax && source.includes(COMPOSER_INERT_PATCHED)
  if (!needsRelax && !upstreamFixed)
    throw new Error(`conversation 产物缺少 composer 语句锚点：${target}`)

  const anchor = source.indexOf(RENDERER_EXPORT_ANCHOR)
  const lineStart = anchor < 0 ? -1 : source.lastIndexOf('\n', anchor) + 1
  const indent = lineStart < 0 ? '' : source.slice(lineStart, anchor)
  if (lineStart < 0 || !/^[\t ]*$/.test(indent))
    throw new Error(`conversation 产物缺少导出锚点 "${RENDERER_EXPORT_ANCHOR}"：${target}`)

  const marker = `${indent}if (typeof document !== "undefined") document.documentElement.setAttribute("${COMPOSER_CWD_ATTRIBUTE}", "1"); /* ${COMPOSER_PATCH_MARKER} */\n`
  const withMarker = `${source.slice(0, lineStart)}${marker}${source.slice(lineStart)}`
  writeFileSync(target, needsRelax ? withMarker.replace(COMPOSER_INERT_ORIGINAL, COMPOSER_INERT_PATCHED) : withMarker)
  log(`🔧 已施加 composer 补丁：${target}`)
}

/**
 * 往 scratch `DSH_HOME` 写入一个确定性技能夹具。
 *
 * 核心的用户技能根是 `<DSH_HOME>/skills`（`dsh-skill-filesystem` 的 `user-dsh` 根），
 * 也正是 `dsh-tauri-extension` 自己保存技能的位置。不写它就等于把「技能目录非空」
 * 外包给运行机的个人技能：开发机 `~/.agents/skills` 有上百个技能，干净 runner 一个都
 * 没有，`/skills` 清单前置在 CI 上必然空。
 */
function seedSkillFixture(home: string): void {
  const dir = join(home, 'skills', FIXTURE_SKILL_NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${FIXTURE_SKILL_NAME}`,
    `description: ${JSON.stringify('dsh E2E 编排写入的确定性技能夹具，用于技能清单与详情前置。')}`,
    '---',
    '',
    `# ${FIXTURE_SKILL_NAME}`,
    '',
    '本文件由 `test/e2e/support/dsh.ts` 的 scratch profile 夹具写入：',
    '让插件车道的 `/skills` 与 `/skill?name=` 在任意运行机上都有确定的对象。',
    '',
  ].join('\n'))
}

/* ==========================================
 * 进程与 CLI 交互
 * ========================================== */

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''

    child.stdout?.on('data', chunk => (output += chunk.toString()))
    child.stderr?.on('data', chunk => (output += chunk.toString()))
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

async function mountViaCli(profileDir: string, home: string, pkgs: readonly string[]): Promise<void> {
  const [dshBin] = resolveDshCommand()
  const storeDir = process.env.DSH_E2E_PNPM_STORE_DIR
  const env: NodeJS.ProcessEnv = {
    ...isolatedDshEnv(home),
    ...(storeDir ? { npm_config_store_dir: storeDir, pnpm_config_store_dir: storeDir } : {}),
  }

  for (const pkg of pkgs) {
    const linkArg = `link:${join(REPO_ROOT, 'packages', pkg)}`
    await run(resolveNodeBin(), [dshBin, 'plugin', '--profile', PROFILE, 'add', linkArg], profileDir, env)
  }
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null)
    return

  const pid = child.pid
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('close', resolvePromise)
      killer.on('error', resolvePromise)
    })
    return
  }

  child.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 1_500))
  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
}

/**
 * 实时从进程流解析 Ready 状态，避免频繁全量读磁盘 logPath
 */
async function waitForReadyStream(child: ChildProcess, logPath: string, logStream: WriteStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout
    const readers = [child.stdout, child.stderr].flatMap(input => input ? [createInterface({ input })] : [])
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      logStream.off('error', onError)
      for (const reader of readers) {
        reader.removeAllListeners('line')
        reader.close()
      }
    }
    function onError(error: Error): void {
      cleanup()
      reject(new Error(`dsh web 启动失败：${error.message}；日志：${logPath}`, { cause: error }))
    }
    function onExit(code: number | null): void {
      cleanup()
      reject(new Error(`dsh web 提前退出（code ${code}）；日志：${logPath}\n${tailOf(logPath)}`))
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等待 dsh web 就绪超时（${READY_TIMEOUT_MS}ms）；日志：${logPath}\n${tailOf(logPath)}`))
    }, READY_TIMEOUT_MS)
    child.once('exit', onExit)
    child.once('error', onError)
    logStream.once('error', onError)
    for (const reader of readers) {
      reader.on('line', (line: string) => {
        const match = READY_RE.exec(line)
        if (match) {
          cleanup()
          resolve(match[0])
        }
      })
    }
  })
}

/** 用就绪 URL 的一次性 token 换浏览器会话 Cookie */
async function exchangeLaunchToken(url: string): Promise<string> {
  const launch = new URL(url)
  if (!launch.searchParams.has('token'))
    return ''

  const response = await fetch(launch.href, { redirect: 'manual' })

  const setCookies = response.headers.getSetCookie()
  const first = setCookies[0] ?? response.headers.get('set-cookie')

  if (response.status !== 303 || !first) {
    throw new Error(
      `token 交换未返回 303 + Set-Cookie（实际 ${response.status}）；`
      + '该宿主可能不支持根路径 token 交换（该通道只在 `GET /?token=` 上生效）',
    )
  }

  return first.split(';', 1)[0].trim()
}

/* ==========================================
 * 主入口导出 (Main Export)
 * ========================================== */

/**
 * 只完成 scratch profile 的创建与挂载，不启动 `dsh web`。
 */
export async function scaffoldDshProfile(options: StartDshHostOptions): Promise<DshProfile> {
  const { plugin, also = [] } = options
  const packages = [...new Set([...also, plugin])]

  for (const pkg of packages)
    assertPluginArtifactsCurrent(REPO_ROOT, pkg)

  const home = mkdtempSync(join(tmpdir(), `dsh-e2e-${plugin}-`))
  const profileDir = join(home, 'profiles', PROFILE)
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...packages]

  try {
    writeProfile(profileDir, bundles)
    seedSkillFixture(home)

    if ((process.env.DSH_E2E_MOUNT ?? 'link') === 'cli') {
      await mountViaCli(profileDir, home, packages)
    }
    else {
      for (const pkg of packages) {
        linkPackage(profileDir, pkg)
        addBundle(profileDir, pkg)
      }
    }

    assertMountRegistered(profileDir, packages)
  }
  catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }

  return { home, profileDir, packages }
}

/**
 * 起一个真实 dsh web 宿主并挂载指定插件。
 * 调用方负责 `stop()`（globalSetup/globalTeardown 保证）。
 */
export async function startDshHost(options: StartDshHostOptions): Promise<DshHost> {
  const [dshBin] = resolveDshCommand()
  const profile = await scaffoldDshProfile(options)
  return startDshProcess(profile, dshBin, options.keepHome ?? false)
}

export async function startDshProcess(profile: DshProfile, dshBin: string, keepHome = false): Promise<DshHost> {
  const { home, profileDir, packages } = profile
  if (!isWithin(realpathSync(tmpdir()), realpathSync(home)) || !basename(home).startsWith('dsh-e2e-') || !isWithin(realpathSync(home), realpathSync(profileDir)))
    throw new Error('DSH 进程仅可使用系统临时目录内的独占 E2E profile。')
  const logPath = join(home, 'dsh-web.log')
  let child: ChildProcess | undefined
  let logStream: WriteStream | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped)
      return
    stopped = true
    if (child)
      await killTree(child)
    if (logStream) {
      child?.stdout?.unpipe(logStream)
      child?.stderr?.unpipe(logStream)
      logStream.end()
      await finished(logStream).catch(() => {})
    }
    if (!keepHome)
      rmSync(home, { recursive: true, force: true })
  }
  try {
    patchCoreClients(dshBin)
    const env = isolatedDshEnv(home)
    const args = [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']
    log(`挂载 DSH 核心 [${coreVersion(dshBin)}] (profile: ${basename(home)})`)
    logStream = createWriteStream(logPath, { flags: 'a' })
    child = spawn(resolveNodeBin(), args, { cwd: profileDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const ready = waitForReadyStream(child, logPath, logStream)
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    const url = await ready
    const baseUrl = new URL(url).origin
    const cookie = await exchangeLaunchToken(url)
    log(`就绪 [${baseUrl}] → ${packages.join(', ')}${keepHome ? ' [keepHome]' : ''}`)
    return { coreVersion: coreVersion(dshBin), url, baseUrl, cookie, home, logPath, mounted: packages, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}
