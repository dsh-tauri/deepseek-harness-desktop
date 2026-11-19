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
import { assertListenerProfile, remoteInstanceStopCommand, remoteSlotClaimShell } from './instance'

const REMOTE_PLUGINS_DIR = `${REMOTE_ROOT}/plugins`
const SYNC_MARKER = `${REMOTE_PLUGINS_DIR}/.sync.json`
const REMOTE_PLUGIN_PACKAGE = 'dsh-tauri-remote'
/** 换树脚本发现远端标记已变时的退出码：这轮判定作废，桌面端重新读标记再判。 */
const MARKER_CHANGED_EXIT = 22
const DECISION_ATTEMPTS = 3

export const WIRE_SCRIPT = `const fs = require('fs')
const path = require('path')
const [profilePkg, base, ...names] = process.argv.slice(2)
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
console.log('wired ' + names.length + ' bundled plugins')
`

export interface BundledPluginsTree {
  root: string
  pluginNames: string[]
  /** 捆绑插件的版本：桌面插件包的版本，用来判断远端这份是谁部署的。 */
  version: string
}

/** 远端捆绑插件的部署标记：内容哈希 + 部署它的桌面版本。 */
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
    const pluginNames = readdirSync(root, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('@') && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .filter((name) => {
        try {
          const manifest = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')) as { dsh?: unknown }
          return manifest.dsh !== undefined
        }
        catch {
          return false
        }
      })
      .sort()
    if (pluginNames.length > 0)
      return { root, pluginNames, version: bundledTreeVersion(root) }
  }
  return undefined
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

/**
 * 这一份捆绑插件要不要装到远端。
 *
 * 远端由另一台桌面部署过时不再覆盖：两端版本不同就会各自认定远端不是自己那份，
 * 轮流把对方的实例停掉重装，共享实例上的其它客户端跟着一起断。
 *
 * 判定必须两端算出同一个结果，否则就是互相顶：版本新的覆盖版本旧的；版本相同
 * （同一发布里的不同构建）按内容哈希定胜负。issue #1572。
 */
export function decidePluginSync(remote: PluginSyncMarker | undefined, ours: PluginSyncMarker): { sync: boolean, reason: string } {
  if (remote === undefined)
    return { sync: true, reason: '' }
  if (remote.hash === ours.hash)
    return { sync: false, reason: '' }
  if (isNewerVersion(ours.version, remote.version) || (ours.version === remote.version && ours.hash > remote.hash))
    return { sync: true, reason: '' }
  return {
    sync: false,
    reason: `远端捆绑插件由版本 ${remote.version} 的桌面部署，本机是 ${ours.version}，未覆盖（两端反复同步会重启共享实例）`,
  }
}

function isNewerVersion(ours: string, theirs: string): boolean {
  const left = semver.valid(ours)
  const right = semver.valid(theirs)
  if (left !== null && right !== null)
    return semver.gt(left, right)
  return ours > theirs
}

/**
 * 换树脚本。
 *
 * `expectedHash` 是桌面端做判定时读到的远端标记：拿到占用声明后再读一次，
 * 对不上就说明这期间别的桌面已经改过远端，这次判定作废（退出码 22，由桌面端重新判定）。
 */
export function pluginSyncApplyCommand(tree: BundledPluginsTree, marker: PluginSyncMarker, profileName: string, remotePort: number, expectedHash: string): string {
  const names = tree.pluginNames.join(' ')
  const profile = `.dsh/profiles/${profileName}`
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
    `if [ "$CURRENT" != "${expectedHash}" ]; then`,
    '  echo "PLUGIN_SYNC_MARKER_CHANGED: 远端捆绑插件标记已变，本次同步作废" >&2',
    '  exit 22',
    'fi',
    // 判定是在拿到声明之前做的：这期间别的桌面可能已经换过远端，这时按旧判定动手会把它顶回去。
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
    ...remoteInstanceStopCommand(profileName, remotePort),
    `if [ -d "$BASE" ]; then mv "$BASE" "$OLD"; fi`,
    `mv "$NEW" "$BASE"`,
    // 旧树删不掉不算失败：新树已经就位，旧树只是留在那儿，下次同步再收。
    `rm -rf "$OLD" 2>/dev/null || true`,
    `[ -f "$HOME/${profile}/package.json" ] || "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile ${profileName} --from-default-profile web --help >/dev/null 2>&1`,
    `"$HOME/${REMOTE_ROOT}/runtime/bin/node" "$BASE/node_modules/_wire.js" "$HOME/${profile}/package.json" "$BASE/node_modules" ${names}`,
    `printf '%s\\n' '${JSON.stringify(marker)}' > "$HOME/${SYNC_MARKER}"`,
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
  const marker: PluginSyncMarker = { hash, version: tree.version }
  const sizeMb = (tar.length / 1024 / 1024).toFixed(1)
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
    const remote = await readRemoteMarker(session)
    const decision = decidePluginSync(remote, marker)
    if (!decision.sync) {
      if (decision.reason !== '')
        hooks.onEvent?.('install', decision.reason)
      return false
    }
    // 端口上跑的不是自己以为的那个档案时不能动它：那是别人的实例。
    await assertListenerProfile(session, remotePort, profileName)
    if (attempt === 0)
      hooks.onEvent?.('install', `同步桌面捆绑插件到远端（${tree.pluginNames.length} 个, ${sizeMb} MB）`)
    const applied = await session.exec(pluginSyncApplyCommand(tree, marker, profileName, remotePort, remote?.hash ?? ''), { stdinData: tar })
    // 拿到占用声明时发现远端标记已经变了：这轮判定作废，重新读一次再判。
    if (applied.code === MARKER_CHANGED_EXIT)
      continue
    if (applied.code !== 0 || !applied.stdout.includes('PLUGINS_SYNCED'))
      throw new Error(`远端插件同步失败: ${applied.stderr.trim() || `exit ${applied.code}`}`)
    hooks.onEvent?.('install', '桌面捆绑插件已同步，远端实例按新 profile 重启')
    return true
  }
  throw new Error('远端插件同步失败: 远端捆绑插件标记反复变化，未能装上这份捆绑插件')
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
