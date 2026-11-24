import type { Buffer } from 'node:buffer'
import type { RemoteMachineStage, RemoteSession } from '../types/index'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import semver from 'semver'
import { BOOTSTRAP_LOG_PREFIX, REMOTE_ROOT } from '../config/constants'
import { readListenerState, remoteInstanceStopCommand, remoteSlotClaimShell } from './instance'

const REMOTE_PLUGINS_DIR = `${REMOTE_ROOT}/plugins`
/** 这份插件目录的状态：内容哈希 + 部署它的桌面版本。它描述目录本身，跟着目录走。 */
const SYNC_MARKER = `${REMOTE_PLUGINS_DIR}/.sync.json`
/** 接线状态按档案各放各的：接线是档案级的事，不放在共享的插件目录里。 */
const PROFILE_STATE_DIR = `${REMOTE_ROOT}/profiles-sync`
const REMOTE_PLUGIN_PACKAGE = 'dsh-tauri-remote'
/** 只在发起端成立的插件：远端没有对应宿主，接过去只会多出用不了的入口。issue #1625 */
const LAUNCHER_ONLY_PLUGINS = ['dsh-tauri-pet', 'dsh-tauri-remote']
/** 换树脚本发现远端标记已变时的退出码：这轮判定作废，桌面端重新读标记再判。 */
const MARKER_CHANGED_EXIT = 22
const DECISION_ATTEMPTS = 3

export const WIRE_SCRIPT = `const fs = require('fs')
const path = require('path')
const [profilePkg, base, profileStatePath, wiringState, allowlist] = process.argv.slice(2)
// 接线集合以资源清单声明的内置插件为准：远端这份目录里可能留着旧版本部署的包，
// 它们和新核心不兼容，接进档案就会 import failed。远端这份可能是别的桌面部署的，
// 所以还要按远端实际目录取交集，不能只信本机的名字。issue #1625
const allowed = new Set(JSON.parse(allowlist))
const names = fs.existsSync(base)
  ? fs.readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && allowed.has(entry.name))
      .map(entry => entry.name)
      .filter(name => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(base, name, 'package.json'), 'utf8'))
          return manifest.dsh !== undefined
        }
        catch {
          return false
        }
      })
      .sort()
  : []
const doc = fs.existsSync(profilePkg)
  ? JSON.parse(fs.readFileSync(profilePkg, 'utf8'))
  : { name: 'dsh-remote', version: '0.0.0', dependencies: {} }
doc.dependencies = doc.dependencies || {}
doc.dsh = doc.dsh || {}
doc.dsh.profile = doc.dsh.profile || {}
doc.dsh.profile.bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : []
const profileModules = path.join(path.dirname(profilePkg), 'node_modules')
fs.mkdirSync(profileModules, { recursive: true })
const managedPrefix = path.resolve(base) + path.sep
for (const name of names) {
  doc.dependencies[name] = 'link:' + path.join(base, name)
  if (!doc.dsh.profile.bundles.includes(name)) doc.dsh.profile.bundles.push(name)
  const link = path.join(profileModules, name)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(path.join(base, name), link, 'dir')
}
for (const name of Object.keys(doc.dependencies)) {
  if (names.includes(name)) continue
  const spec = doc.dependencies[name]
  if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
  const target = path.resolve(path.dirname(profilePkg), spec.slice(5))
  if (!target.startsWith(managedPrefix)) continue
  delete doc.dependencies[name]
  doc.dsh.profile.bundles = doc.dsh.profile.bundles.filter(b => b !== name)
  fs.rmSync(path.join(profileModules, name), { recursive: true, force: true })
}
fs.writeFileSync(profilePkg, JSON.stringify(doc, null, 2) + '\\n')
// 接线状态按档案记：接线是档案级的事，不写进共享的插件目录（那里放的是目录本身的状态）。
if (profileStatePath && wiringState) {
  fs.mkdirSync(path.dirname(profileStatePath), { recursive: true })
  const temp = profileStatePath + '.tmp'
  fs.writeFileSync(temp, wiringState + '\\n')
  fs.renameSync(temp, profileStatePath)
}
console.log('wired ' + names.length + ' bundled plugins')
`

export interface BundledPluginsTree {
  root: string
  pluginNames: string[]
  /** 捆绑插件的版本：桌面插件包的版本，用来判断远端这份是谁部署的。 */
  version: string
}

/** 远端这份插件目录的状态：内容哈希 + 部署它的桌面版本。 */
export interface PluginSyncMarker {
  hash: string
  version: string
}

export function findBundledPluginsTree(ownPkgDir = dirname(realpathSync(fileURLToPath(import.meta.url)))): BundledPluginsTree | undefined {
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(ownPkgDir, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name === 'dsh-tauri-remote')
        break
    }
    catch { /* 继续上溯 */ }
    ownPkgDir = dirname(ownPkgDir)
  }
  const candidates = [
    dirname(ownPkgDir),
    resolve(ownPkgDir, '../../src-tauri/resources/node_modules'),
  ]
  for (const root of candidates) {
    if (!existsSync(join(root, REMOTE_PLUGIN_PACKAGE, 'package.json'))
      || !existsSync(join(root, 'ssh2', 'package.json'))) {
      continue
    }
    const declared = declaredBuiltinPlugins(root)
    if (declared === undefined)
      continue
    const allowed = new Set(declared.filter(name => !LAUNCHER_ONLY_PLUGINS.includes(name)))
    const pluginNames = readdirSync(root)
      .filter(name => allowed.has(name) && declaresDsh(root, name))
      .sort()
    if (pluginNames.length > 0)
      return { root, pluginNames, version: bundledTreeVersion(root) }
  }
  return undefined
}

/**
 * 资源清单（与插件目录同级的 `manifest.jsonc`）声明的内置插件包名。
 *
 * 插件目录会留下旧版本部署的包：它们同样带 `dsh` 字段，但和新核心不兼容，
 * 接进远端档案后一启动就 import failed。清单缺失或没有声明时返回 undefined，
 * 宁可不同步也不按「带 dsh 字段就算」把旧包接过去。issue #1625
 */
function declaredBuiltinPlugins(root: string): string[] | undefined {
  try {
    const raw = readFileSync(join(dirname(root), 'manifest.jsonc'), 'utf8')
    const doc = JSON.parse(stripJsonc(raw.replace(/^\uFEFF/u, ''))) as { plugins?: Record<string, unknown> }
    const entries = doc.plugins?.['built-in']
    if (!Array.isArray(entries))
      return undefined
    const names = entries
      .map(entry => typeof entry === 'string' ? entry : (entry as { spec?: unknown }).spec)
      .filter((spec): spec is string => typeof spec === 'string' && spec !== '')
      .map(packageNameOf)
    return names.length > 0 ? names : undefined
  }
  catch {
    return undefined
  }
}

/** `dsh-third-kernel@0.1.0` 取 `dsh-third-kernel`；作用域包名里的 `@` 不是版本分隔。 */
function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

function declaresDsh(root: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')) as { dsh?: unknown }
    return manifest.dsh !== undefined
  }
  catch {
    return false
  }
}

/**
 * 清单是 JSONC：注释与尾逗号都要先摘掉再交给 JSON.parse。
 *
 * 尾逗号不能靠「逗号后面看一眼」判断：逗号和收尾括号之间可能夹着注释，注释摘掉之后
 * 才看得出它是尾逗号。所以记下逗号的位置，等下一个实义字符出现时再定。
 */
function stripJsonc(raw: string): string {
  let out = ''
  let inString = false
  let comma = -1
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index)
    if (inString) {
      out += char
      if (char === '\\') {
        out += raw.charAt(index + 1)
        index += 1
      }
      else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      // 字符串本身就是「下一个实义字符」：待定的逗号是元素分隔符，不是尾逗号。
      comma = -1
      inString = true
      out += char
      continue
    }
    if (char === '/' && raw.charAt(index + 1) === '/') {
      while (index < raw.length && raw.charAt(index) !== '\n')
        index += 1
      continue
    }
    if (char === '/' && raw.charAt(index + 1) === '*') {
      index += 2
      while (index + 1 < raw.length && !(raw.charAt(index) === '*' && raw.charAt(index + 1) === '/'))
        index += 1
      index += 1
      continue
    }
    if (char === ',') {
      comma = out.length
      out += char
      continue
    }
    if (/\s/u.test(char)) {
      out += char
      continue
    }
    if (comma >= 0 && (char === '}' || char === ']'))
      out = out.slice(0, comma) + out.slice(comma + 1)
    comma = -1
    out += char
  }
  return out
}

function bundledTreeVersion(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(root, REMOTE_PLUGIN_PACKAGE, 'package.json'), 'utf8')) as { version?: string }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

/**
 * 捆绑插件的内容哈希。
 *
 * 不能用压缩包的哈希：tar 里带着文件时间，同一份内容在两台机器上打包出来的哈希不一样，
 * 两端就会互相判定「远端不是我这份」而反复重装。内容哈希只看文件本身。issue #1572。
 */
export function bundleContentHash(root: string): string {
  const hash = createHash('sha256')
  for (const entry of walkTree(root)) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.kind)
    hash.update('\0')
    hash.update(entry.digest)
    hash.update('\0')
  }
  return hash.digest('hex')
}

interface TreeEntry {
  path: string
  kind: string
  digest: string
}

function walkTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  const walk = (dir: string, prefix: string): void => {
    const items = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const item of items) {
      const path = join(dir, item.name)
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'l', digest: readlinkSync(path) })
        continue
      }
      if (item.isDirectory()) {
        entries.push({ path: relative, kind: 'd', digest: '' })
        walk(path, relative)
        continue
      }
      if (!item.isFile())
        continue
      entries.push({ path: relative, kind: 'f', digest: createHash('sha256').update(readFileSync(path)).digest('hex') })
    }
  }
  walk(root, '')
  return entries
}

export async function buildPluginsBundle(tree: BundledPluginsTree): Promise<{ tar: Buffer, hash: string }> {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-plugins-wire-'))
  try {
    writeFileSync(join(staging, '_wire.js'), WIRE_SCRIPT)
    const pending = promisify(execFile)('tar', ['-czf', '-', '-C', tree.root, '.', '-C', staging, '_wire.js'], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    })
    pending.child.stdin?.end()
    const { stdout: tar } = await pending
    return { tar, hash: bundleContentHash(tree.root) }
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function pluginSyncMarkerCommand(): string {
  return `cat "$HOME/${SYNC_MARKER}" 2>/dev/null || true`
}

/** 这个档案接过线的状态（内容哈希 + 插件名单指纹）：没接过线就是空。 */
export function pluginSyncProfileStateCommand(profileName: string): string {
  return `cat "$HOME/${PROFILE_STATE_DIR}/${profileName}" 2>/dev/null || true`
}

/** 一次同步要做的事：换树与接线是两件事。 */
export interface PluginSyncPlan {
  /** 要不要把远端这份插件目录换成本机这份。 */
  replaceTree: boolean
  /** 要不要给目标档案接线。跳过换树时接线仍然要做。 */
  wireProfile: boolean
  /** 做完之后远端那份插件目录的内容哈希。 */
  treeHash: string
  /** 远端那份插件目录是谁部署的版本。 */
  treeVersion: string
  reason: string
}

/**
 * 这一份捆绑插件要不要装到远端。
 *
 * 远端由另一台桌面部署过时不再覆盖：两端版本不同就会各自认定远端不是自己那份，
 * 轮流把对方的实例停掉重装，共享实例上的其它客户端跟着一起断。
 *
 * 判定必须两端算出同一个结果，否则就是互相顶：版本新的覆盖版本旧的；版本相同
 * （同一发布里的不同构建）按内容哈希定胜负。issue #1572。
 *
 * 换树与接线分开：插件目录是整台远端共享的，接线是按档案的。远端这份由别的桌面部署时，
 * 本机不换树，但本机这个档案还没接过线，就只补接线——否则那个档案会一直缺捆绑插件。
 *
 * 接线状态里带名单指纹：清单少一个内置插件时，插件目录的内容哈希可能一点没变
 * （旧包还留在目录里），只看哈希就会跳过接线，旧插件一直挂在档案上。
 */
export function planPluginSync(remote: PluginSyncMarker | undefined, ours: PluginSyncMarker, wired: string | undefined, pluginNames: string[]): PluginSyncPlan {
  if (remote === undefined) {
    return { replaceTree: true, wireProfile: true, treeHash: ours.hash, treeVersion: ours.version, reason: '' }
  }
  const replaceTree = remote.hash !== ours.hash && winsOver(ours, remote)
  const treeHash = replaceTree ? ours.hash : remote.hash
  const treeVersion = replaceTree ? ours.version : remote.version
  const wireProfile = wired !== wiringStateOf(treeHash, pluginNames)
  const reason = !replaceTree && remote.hash !== ours.hash
    ? `远端捆绑插件由版本 ${remote.version} 的桌面部署，本机是 ${ours.version}，未覆盖（两端反复同步会重启共享实例）`
    : ''
  return { replaceTree, wireProfile, treeHash, treeVersion, reason }
}

/** 一个档案「接过线」的完整身份：接到哪份插件目录，以及接的是哪一批插件。 */
export function wiringStateOf(treeHash: string, pluginNames: string[]): string {
  const digest = createHash('sha256').update(pluginNames.join('\n')).digest('hex').slice(0, 16)
  return `${treeHash}:${digest}`
}

function winsOver(ours: PluginSyncMarker, theirs: PluginSyncMarker): boolean {
  if (isNewerVersion(ours.version, theirs.version))
    return true
  return ours.version === theirs.version && ours.hash > theirs.hash
}

function isNewerVersion(ours: string, theirs: string): boolean {
  const left = semver.valid(ours)
  const right = semver.valid(theirs)
  if (left !== null && right !== null)
    return semver.gt(left, right)
  return ours > theirs
}

/**
 * 换树与接线的远端脚本。
 *
 * `expectedHash` 是桌面端做判定时读到的远端标记：拿到占用声明后再读一次，
 * 对不上就说明这期间别的桌面已经改过远端，这次判定作废（退出码 22，由桌面端重新判定）。
 *
 * `replaceTree` 决定要不要把远端那份插件目录换成本机这份；不换树时只给目标档案接线。
 * 接线脚本固定用当前这份实现（远端树里那份可能是旧版，参数形式不同）。
 */
export function pluginSyncApplyCommand(options: {
  profileName: string
  remotePort: number
  expectedHash: string
  replaceTree: boolean
  treeHash: string
  treeVersion: string
  /** 要接进档案的插件名：资源清单声明的内置插件，不含只在发起端成立的插件。 */
  pluginNames: string[]
}): string {
  const profile = `.dsh/profiles/${options.profileName}`
  const wiringState = wiringStateOf(options.treeHash, options.pluginNames)
  return [
    'set -e',
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `BASE="$HOME/${REMOTE_PLUGINS_DIR}"`,
    'TMP="$ROOT/tmp/plugins-sync.$$"',
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'cleanup() { rm -rf "$TMP"; rm -f "$CLAIM"; }',
    'trap cleanup EXIT',
    // 活动槽位的占用声明：换树要停远端实例，与切换核心、强制重装共用同一把锁。
    ...remoteSlotClaimShell('dsh', { busyText: '远端实例正被其它操作改动（切换核心、强制重装或插件同步）' }),
    // 判定是在拿到声明之前做的：这期间别的桌面可能已经换过远端，这时按旧判定动手会把它顶回去。
    `CURRENT="$(sed -n 's/.*"hash":"\\([^"]*\\)".*/\\1/p' "$HOME/${SYNC_MARKER}" 2>/dev/null | head -n 1)"`,
    `if [ "$CURRENT" != "${options.expectedHash}" ]; then`,
    '  echo "PLUGIN_SYNC_MARKER_CHANGED: 远端捆绑插件标记已变，本次同步作废" >&2',
    '  exit 22',
    'fi',
    // 接线脚本用当前这份实现，不依赖远端树里那份：那份可能是旧版，参数形式不同。
    'cat > "$TMP/_wire.js" <<\'DSH_WIRE_EOF\'',
    WIRE_SCRIPT,
    'DSH_WIRE_EOF',
    ...(options.replaceTree
      ? [
          `TAG="$$-$(date +%s)"`,
          `NEW="$BASE.new.$TAG"`,
          `OLD="$BASE.old.$TAG"`,
          // 暂存目录按写入方隔离：只回收写入方已经不在的目录，别人的正在写的目录不能删。
          'for _d in "$BASE".new.* "$BASE".old.*; do',
          '  [ -d "$_d" ] || continue',
          '  _pid="$(basename "$_d" | sed \'s/^.*\\.//\' | cut -d- -f1)"',
          '  case "$_pid" in "" | *[!0-9]*) continue ;; esac',
          '  kill -0 "$_pid" 2>/dev/null || rm -rf "$_d" 2>/dev/null || true',
          'done',
          `mkdir -p "$NEW/node_modules"`,
          `tar -xzf - -C "$NEW/node_modules"`,
        ]
      : []),
    ...remoteInstanceStopCommand(options.profileName, options.remotePort),
    ...(options.replaceTree
      ? [
          `if [ -d "$BASE" ]; then mv "$BASE" "$OLD"; fi`,
          `mv "$NEW" "$BASE"`,
          // 旧树删不掉不算失败：新树已经就位，旧树只是留在那儿，下次同步再收。
          `rm -rf "$OLD" 2>/dev/null || true`,
        ]
      : []),
    // 接线：档案的 package.json 与 node_modules 指向这份插件目录。
    `[ -f "$HOME/${profile}/package.json" ] || "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile ${options.profileName} --from-default-profile web --help >/dev/null 2>&1`,
    `"$HOME/${REMOTE_ROOT}/runtime/bin/node" "$TMP/_wire.js" "$HOME/${profile}/package.json" "$BASE/node_modules" "$HOME/${PROFILE_STATE_DIR}/${options.profileName}" "${wiringState}" '${JSON.stringify(options.pluginNames)}'`,
    // 这份目录的状态跟着目录走：换完树再写，写的就是现在这份。接线没成功就不写。
    ...(options.replaceTree
      ? [`printf '%s\\n' '{"hash":"${options.treeHash}","version":"${options.treeVersion}"}' > "$HOME/${SYNC_MARKER}"`]
      : []),
    'echo PLUGINS_SYNCED',
  ].join('\n')
}

export async function syncBundledPlugins(
  session: RemoteSession,
  profileName: string,
  remotePort: number,
  hooks: { onEvent?: (stage: RemoteMachineStage, line: string) => void, tree?: BundledPluginsTree | undefined } = {},
): Promise<boolean> {
  const tree = hooks.tree ?? findBundledPluginsTree()
  if (tree === undefined) {
    hooks.onEvent?.('install', '未找到本地捆绑插件树（dev 环境需先 build:plugins），跳过远端同步')
    return false
  }
  const { tar, hash } = await buildPluginsBundle(tree)
  const ours: PluginSyncMarker = { hash, version: tree.version }
  const sizeMb = (tar.length / 1024 / 1024).toFixed(1)
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
    const remote = await readRemoteMarker(session)
    const wired = await readProfileState(session, profileName)
    const plan = planPluginSync(remote, ours, wired, tree.pluginNames)
    if (!plan.replaceTree && !plan.wireProfile) {
      if (plan.reason !== '')
        hooks.onEvent?.('install', plan.reason)
      return false
    }
    // 捆绑插件同步会写远端档案目录、可能重启实例。处于后台 connect 路径、没有 UI 确认点，
    // 因此三态发现为 mismatch 时只记警告并跳过本次同步，绝不静默覆盖别人的实例（issue #1600 C 策略）。
    const listener = await readListenerState(session, remotePort, profileName)
    if (listener.verdict === 'mismatch') {
      hooks.onEvent?.('install', `跳过捆绑插件同步：端口 ${remotePort} 上的实例用的是档案「${listener.actual}」，与本机配置的「${profileName}」不符；为避免打断别人的实例，未写入，请在档案面板确认后再处理`)
      return false
    }
    if (attempt === 0) {
      hooks.onEvent?.('install', plan.replaceTree
        ? `同步桌面捆绑插件到远端（${tree.pluginNames.length} 个, ${sizeMb} MB）`
        : `远端捆绑插件由别的桌面部署，本机只给档案 ${profileName} 补接线`)
    }
    const command = pluginSyncApplyCommand({
      profileName,
      remotePort,
      expectedHash: remote?.hash ?? '',
      replaceTree: plan.replaceTree,
      treeHash: plan.treeHash,
      treeVersion: plan.treeVersion,
      pluginNames: tree.pluginNames,
    })
    const applied = await session.exec(command, plan.replaceTree ? { stdinData: tar } : {})
    // 拿到占用声明时发现远端标记已经变了：这轮判定作废，重新读一次再判。
    if (applied.code === MARKER_CHANGED_EXIT)
      continue
    if (applied.code !== 0 || !applied.stdout.includes('PLUGINS_SYNCED'))
      throw new Error(`远端插件同步失败: ${applied.stderr.trim() || `exit ${applied.code}`}`)
    hooks.onEvent?.('install', plan.replaceTree ? '桌面捆绑插件已同步，远端实例按新 profile 重启' : '远端档案已接线')
    return true
  }
  throw new Error('远端插件同步失败: 远端捆绑插件标记反复变化，未能装上这份捆绑插件')
}

async function readProfileState(session: RemoteSession, profileName: string): Promise<string | undefined> {
  const result = await session.exec(pluginSyncProfileStateCommand(profileName))
  const text = result.stdout.trim()
  return text === '' ? undefined : text
}

async function readRemoteMarker(session: RemoteSession): Promise<PluginSyncMarker | undefined> {
  const result = await session.exec(pluginSyncMarkerCommand())
  const text = result.stdout.trim()
  if (text === '')
    return undefined
  try {
    const parsed = JSON.parse(text) as { hash?: unknown, version?: unknown }
    if (typeof parsed.hash !== 'string' || typeof parsed.version !== 'string')
      return undefined
    return { hash: parsed.hash, version: parsed.version }
  }
  catch {
    return undefined
  }
}
