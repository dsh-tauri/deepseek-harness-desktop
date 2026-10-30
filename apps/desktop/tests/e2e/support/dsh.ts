import type { ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { gte, valid } from 'semver'
import { assertPluginArtifactsCurrent } from './artifacts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const PROFILE = 'web'

export function pluginDir(pkg: string): string {
  const packages = join(REPO_ROOT, 'packages')
  const match = readdirSync(packages).find(dir => dir.startsWith('builtin-plugin-') && readJson<PkgManifest>(join(packages, dir, 'package.json'))?.name === pkg)
  if (!match)
    throw new Error(`未找到插件包目录：${pkg}`)
  return join(packages, match)
}

const READY_RE = /http:\/\/127\.0\.0\.1:\d\S*/

const READY_TIMEOUT_MS = 120_000

const MINIMUM_CORE_VERSION = '0.2.1-rc.4'

export interface StartDshHostOptions {
  plugin: string
  also?: readonly string[]
  keepHome?: boolean
}

export interface DshProfile {
  readonly home: string
  readonly profileDir: string
  readonly packages: readonly string[]
}

export interface DshHost {
  readonly coreVersion: string
  readonly url: string
  readonly baseUrl: string
  readonly cookie: string
  readonly home: string
  readonly logPath: string
  readonly mounted: readonly string[]
  stop: () => Promise<void>
}

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

interface PkgManifest {
  name?: string
  version?: string
  main?: string
  exports?: Record<string, unknown>
}

function log(message: string): void {
  process.stderr.write(`[dsh] ${message}\n`)
}

export function resolveNodeBin(): string {
  return process.env.DSH_E2E_NODE_BIN ?? process.execPath
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  }
  catch {
    return null
  }
}

function updateJson<T>(filePath: string, updater: (data: T) => T): void {
  const data = readJson<T>(filePath) ?? ({} as T)
  const nextData = updater(data)
  writeFileSync(filePath, `${JSON.stringify(nextData, null, 2)}\n`)
}

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

function linkPackage(profileDir: string, pkg: string): void {
  const source = pluginDir(pkg)

  const target = join(profileDir, 'node_modules', pkg)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })

  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

function readBundles(profileDir: string): string[] {
  return readJson<ProfileManifest>(join(profileDir, 'package.json'))?.dsh?.profile?.bundles ?? []
}

function addBundle(profileDir: string, pkg: string): void {
  const manifestPath = join(profileDir, 'package.json')
  updateJson<ProfileManifest>(manifestPath, (manifest) => {
    const dependencies = manifest.dependencies ?? {}
    dependencies[pkg] = `link:${pluginDir(pkg)}`

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

export function assertMountRegistered(profileDir: string, packages: readonly string[]): void {
  const registered = readBundles(profileDir)
  const missing = packages.filter(pkg => !registered.includes(pkg))
  if (missing.length > 0) {
    throw new Error(`挂载未注册到 dsh.profile.bundles：${missing.join(', ')}`)
  }
}

const RENDERER_PACKAGE = 'dsh-client-ui-renderer'

const CONVERSATION_PACKAGE = 'dsh-client-ui-conversation'

const RENDERER_EXPORT_ANCHOR = 'return module.exports;'

const COMPOSER_INERT_ORIGINAL = 'const inert = sessionId === void 0 || hero && chipTitle === void 0;'
const COMPOSER_INERT_PATCHED = 'const inert = sessionId === void 0 || hero && chipTitle === void 0 && cwd === void 0;'
const COMPOSER_PATCH_MARKER = 'dsh-tauri: composer stays usable for a session outside every workspace'
const COMPOSER_CWD_ATTRIBUTE = 'data-dsh-composer-cwd'

const FIXTURE_SKILL_NAME = 'e2e-fixture-skill'

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

function patchComposerCwd(dshBin: string): void {
  const coreDir = dirname(dirname(dshBin))
  const target = locateCoreClient(coreDir, CONVERSATION_PACKAGE)

  if (target === undefined)
    throw new Error(`未找到 conversation 客户端产物，无法施加 composer 补丁：${coreDir}`)

  const source = readFileSync(target, 'utf8')
  if (source.includes(COMPOSER_PATCH_MARKER))
    return

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
    const linkArg = `link:${pluginDir(pkg)}`
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

export async function scaffoldDshProfile(options: StartDshHostOptions): Promise<DshProfile> {
  const { plugin, also = [] } = options
  const packages = [...new Set([...also, plugin])]

  for (const pkg of packages)
    assertPluginArtifactsCurrent(REPO_ROOT, basename(pluginDir(pkg)))

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
