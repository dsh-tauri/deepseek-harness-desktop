import type { Buffer } from 'node:buffer'
import type { RemoteMachineStage, RemoteSession } from '../types/index'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { REMOTE_ROOT } from '../config/constants'

const REMOTE_PLUGINS_DIR = `${REMOTE_ROOT}/plugins`
const SYNC_MARKER = `${REMOTE_PLUGINS_DIR}/.sync-sha256`
const REMOTE_PIDFILE = '.dsh/dsh-remote.pid'

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
    if (!existsSync(join(root, 'dsh-tauri-remote', 'package.json'))
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
    return { tar, hash: createHash('sha256').update(tar).digest('hex') }
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function pluginSyncMarkerCommand(): string {
  return `cat "$HOME/${SYNC_MARKER}" 2>/dev/null || true`
}

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
    `[ -f "$HOME/${REMOTE_PIDFILE}" ] && kill "$(cat "$HOME/${REMOTE_PIDFILE}")" 2>/dev/null || true`,
    `pkill -f "$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web" 2>/dev/null || true`,
    `i=0; while [ $i -lt 50 ] && (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null; do i=$((i+1)); sleep 0.2; done`,
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
