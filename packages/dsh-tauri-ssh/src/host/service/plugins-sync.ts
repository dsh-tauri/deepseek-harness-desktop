/**
 * Sync the desktop-bundled internal plugins (`dsh-tauri-*`) to the remote
 * instance. The desktop shell carries these plugins in every local window;
 * a remote machine without them renders the stock upstream UI (its own
 * "open-in-app" banner, no desktop sidebar surface) — the remote window must
 * differ from the local one ONLY in the backend it talks to.
 *
 * Mechanism (verified against `@deepseek-ai/dsh-app-boot` profile loading):
 * - the deployed tree `src-tauri/resources/node_modules` (build:plugins
 *   `pnpm deploy` output) is a flat node_modules: 12 plugin packages plus
 *   their hoisted third-party deps — uploaded verbatim as ONE tarball;
 * - a profile composes `dsh.profile.bundles` entries, and each plugin
 *   package declares `dsh.bundle.patch` (its own `cordis.patch.yml`), so
 *   adding the plugin names to the remote profile's bundles + `link:`
 *   dependencies + node_modules symlinks mounts them exactly like the
 *   desktop's internal install does locally;
 * - a content hash marker skips re-uploads; when the tree changed and an
 *   instance is already running, its recorded pid is killed so the normal
 *   ensure-launch flow restarts it onto the new profile.
 *
 * Failure policy: best-effort. A sync failure (no local tree, upload error)
 * downgrades to the stock remote UI — the connect itself must not fail.
 * @module dsh-tauri-ssh/host/service/plugins-sync
 */

import type { Buffer } from 'node:buffer'
import type { SshMachineStage } from '../types/index'
import type { SshSession } from './transport'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Remote root of the desktop-managed runtime (mirrors bootstrap REMOTE_ROOT). */
const REMOTE_ROOT = '.dsh-desktop'
/** Remote directory the plugin tree is synced into (flat node_modules inside). */
const REMOTE_PLUGINS_DIR = `${REMOTE_ROOT}/plugins`
/** Remote marker recording the last synced tree hash. */
const SYNC_MARKER = `${REMOTE_PLUGINS_DIR}/.sync-sha256`
/** Remote pidfile written by the instance start command (bootstrap.ts). */
const REMOTE_PIDFILE = '.dsh/dsh-remote.pid'

/** The wiring helper uploaded alongside the tree (keeps shell quoting trivial). */
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

/** One local bundled-plugin tree: its root dir and the plugin package names. */
export interface BundledPluginsTree {
  /** The flat node_modules root (plugin dirs + hoisted deps as siblings). */
  root: string
  /** Package names carrying a `dsh` manifest field (the mountable plugins). */
  pluginNames: string[]
}

/**
 * Locate the deployed bundled-plugin tree from this plugin's own installed
 * location. Release layout: the profile `link:` lands us inside
 * `resources/node_modules/<name>` — the parent IS the tree. Dev layout: the
 * profile links to `packages/<name>` sources, so fall back to the repo's
 * `src-tauri/resources/node_modules` (build:plugins output). A candidate
 * qualifies only when it holds both a known plugin and a known third-party
 * dep (the source `packages/` dir fails that check).
 */
export function findBundledPluginsTree(): BundledPluginsTree | undefined {
  // 自定位包根：运行时住在 dist/index.js（dist 上一层即包根），测试住在
  // src/host/service/（需上溯更多层）——统一「向上找自己的 package.json」
  let ownPkgDir = dirname(realpathSync(fileURLToPath(import.meta.url)))
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(ownPkgDir, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name === 'dsh-tauri-ssh')
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
    if (!existsSync(join(root, 'dsh-tauri-ssh-ui', 'package.json'))
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
      return { root, pluginNames }
  }
  return undefined
}

/**
 * Build the sync tarball (tree content + the wiring helper as `_wire.js`)
 * and its content hash. The hash rides the marker file on the remote, so a
 * rebuilt tree (dev iteration) re-syncs on the next connect while an
 * unchanged tree costs one cheap `cat`.
 */
export async function buildPluginsBundle(tree: BundledPluginsTree): Promise<{ tar: Buffer, hash: string }> {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-plugins-wire-'))
  try {
    writeFileSync(join(staging, '_wire.js'), WIRE_SCRIPT)
    const tar = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const child = execFile('tar', ['-czf', '-', '-C', tree.root, '.', '-C', staging, '_wire.js'], {
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      }, (error, stdout) => {
        if (error !== null) {
          rejectPromise(error)
          return
        }
        resolvePromise(stdout)
      })
      child.stdin?.end()
    })
    return { tar, hash: createHash('sha256').update(tar).digest('hex') }
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** The remote marker-read command (empty stdout = never synced / unknown). */
export function pluginSyncMarkerCommand(): string {
  return `cat "$HOME/${SYNC_MARKER}" 2>/dev/null || true`
}

/**
 * The one-shot remote sync script: extract the tarball from stdin, atomic
 * swap, record the hash marker, wire the profile (deps link entries +
 * bundles entries + node_modules symlinks via the uploaded `_wire.js`), and
 * restart a running instance so the ensure-launch flow relaunches it onto
 * the new profile.
 */
export function pluginSyncApplyCommand(tree: BundledPluginsTree, hash: string, profileName: string, remotePort: number): string {
  const names = tree.pluginNames.join(' ')
  const profile = `.dsh/profiles/${profileName}`
  return [
    'set -e',
    `BASE="$HOME/${REMOTE_PLUGINS_DIR}"`,
    `rm -rf "$BASE.new" && mkdir -p "$BASE.new/node_modules"`,
    `tar -xzf - -C "$BASE.new/node_modules"`,
    `rm -rf "$BASE.old"`,
    `[ -d "$BASE" ] && mv "$BASE" "$BASE.old" || true`,
    `mv "$BASE.new" "$BASE"`,
    `rm -rf "$BASE.old"`,
    `echo "${hash}" > "$HOME/${SYNC_MARKER}"`,
    `[ -f "$HOME/${profile}/package.json" ] || "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile ${profileName} --from-default-profile web --help >/dev/null 2>&1`,
    `"$HOME/${REMOTE_ROOT}/runtime/bin/node" "$BASE/node_modules/_wire.js" "$HOME/${profile}/package.json" "$BASE/node_modules" ${names}`,
    // 实例在跑则重启：pidfile 之外还按安装路径精确清场（pidfile 可能因上次崩溃
    // 指向已死进程），并等远端实例端口释放后再交还 ensure 拉起，避免新实例 EADDRINUSE
    `[ -f "$HOME/${REMOTE_PIDFILE}" ] && kill "$(cat "$HOME/${REMOTE_PIDFILE}")" 2>/dev/null || true`,
    `pkill -f "$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web" 2>/dev/null || true`,
    `i=0; while [ $i -lt 50 ] && (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null; do i=$((i+1)); sleep 0.2; done`,
    'echo PLUGINS_SYNCED',
  ].join('\n')
}

/**
 * Sync the bundled plugins when the tree changed (hash marker mismatch).
 * @returns whether the remote was modified (instance restart triggered).
 */
export async function syncBundledPlugins(
  session: SshSession,
  profileName: string,
  remotePort: number,
  hooks: { onEvent?: (stage: SshMachineStage, line: string) => void } = {},
): Promise<boolean> {
  const tree = findBundledPluginsTree()
  if (tree === undefined) {
    hooks.onEvent?.('install', '未找到本地捆绑插件树（dev 环境需先 build:plugins），跳过远端同步')
    return false
  }
  const { tar, hash } = await buildPluginsBundle(tree)
  const marker = await session.exec(pluginSyncMarkerCommand())
  if (marker.stdout.trim() === hash)
    return false
  const sizeMb = (tar.length / 1024 / 1024).toFixed(1)
  hooks.onEvent?.('install', `同步桌面捆绑插件到远端（${tree.pluginNames.length} 个, ${sizeMb} MB）`)
  const applied = await session.exec(pluginSyncApplyCommand(tree, hash, profileName, remotePort), { stdinData: tar })
  if (applied.code !== 0 || !applied.stdout.includes('PLUGINS_SYNCED'))
    throw new Error(`远端插件同步失败: ${applied.stderr.trim() || `exit ${applied.code}`}`)
  hooks.onEvent?.('install', `桌面捆绑插件已同步，远端实例按新 profile 重启`)
  return true
}
