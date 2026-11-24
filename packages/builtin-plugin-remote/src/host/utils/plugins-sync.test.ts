import type { MachineProfile } from '../types/index'
import type { PluginSyncMarker } from './plugins-sync'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { remotePidfile } from '../config/constants'
import { startCommandFor } from '../service/bootstrap.utils'
import { MachineId } from '../types/index'
import { bundleContentHash, findBundledPluginsTree, planPluginSync, pluginSyncApplyCommand, pluginSyncMarkerCommand, WIRE_SCRIPT, wiringStateOf } from './plugins-sync'

const PROFILE = 'plugins-sync-test'
const REMOTE_PORT = 41983
const HASH = 'b7e9c1f2d4a6'
const OURS: PluginSyncMarker = { hash: HASH, version: '0.6.7' }
const NAMES = ['plugin-alpha']
const WIRED = wiringStateOf(HASH, NAMES)

const SHELL_AVAILABLE = spawnSync('sh', ['-c', 'command -v tar >/dev/null 2>&1 && command -v kill >/dev/null 2>&1']).status === 0
/** 接线脚本按目录建符号链接；Windows 未开开发者模式时建链接会被拒绝，只能在支持的平台跑。 */
const SYMLINK_AVAILABLE = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'dsh-symlink-probe-'))
  try {
    mkdirSync(join(probe, 'target'))
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir')
    return true
  }
  catch {
    return false
  }
  finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()
const PKILL_AVAILABLE = spawnSync('pkill', ['-f', 'dsh-plugins-sync-probe-absent']).status === 1
const PS_ARGS_AVAILABLE = spawnSync('sh', ['-c', 'ps -p $$ -o args= >/dev/null 2>&1']).status === 0

const NODE_STUB = `#!/bin/sh
# An inline script (-e) runs and exits right away, like the real runtime does.
# It is not the instance, so it does not belong in the argv log the pkill
# fallback matches against.
for _arg in "$@"; do
  if [ "$_arg" = "-e" ]; then exit 0; fi
done
if [ -n "$STUB_ARGV_LOG" ]; then printf '%s\\n' "$0 $*" >> "$STUB_ARGV_LOG"; fi
case "$*" in
  *_wire.js*)
    if [ -n "$STUB_WIRE_STATUS" ]; then printf 'wired %s\\n' "$*"; exit "$STUB_WIRE_STATUS"; fi
    # 接线真的跑一遍：标记里的接线记录就是它写的。
    exec "$STUB_REAL_NODE" "$@"
    ;;
esac
if [ "$STUB_NODE_EXIT" = "1" ]; then exit 0; fi
while :; do sleep 1; done
`

interface Sandbox {
  home: string
  plugins: string
  logs: string
}

const sandboxes: Sandbox[] = []
const scratchDirs: string[] = []
const startedPids: number[] = []
let staging = ''
let cachedArchive: Buffer | undefined

function posix(path: string): string {
  return path.replaceAll('\\', '/')
}

function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

function writeExecutable(path: string, content: string): void {
  ensureDirectory(dirname(path))
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function createSandbox(): Sandbox {
  const home = ensureDirectory(join(mkdtempSync(join(tmpdir(), 'dsh-plugins-sync-')), 'home'))
  const logs = ensureDirectory(join(home, '..', 'logs'))
  writeExecutable(join(home, '.dsh-desktop', 'runtime', 'bin', 'node'), NODE_STUB)
  writeFileSync(join(ensureDirectory(join(home, '.dsh-desktop', 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')), 'bin.js'), '')
  writeFileSync(join(ensureDirectory(join(home, '.dsh', 'profiles', PROFILE)), 'package.json'), '{}')
  writeFileSync(join(ensureDirectory(join(home, '.dsh-desktop', 'plugins', 'node_modules')), 'legacy.txt'), '旧树残留')
  const sandbox = { home, plugins: join(home, '.dsh-desktop', 'plugins'), logs }
  sandboxes.push(sandbox)
  return sandbox
}

function childEnv(sandbox: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: posix(sandbox.home), STUB_REAL_NODE: process.execPath, ...extra }
}

function archive(): Buffer {
  if (cachedArchive !== undefined)
    return cachedArchive
  staging = ensureDirectory(mkdtempSync(join(tmpdir(), 'dsh-plugins-sync-tree-')))
  writeFileSync(join(ensureDirectory(join(staging, 'plugin-alpha')), 'package.json'), '{"name":"plugin-alpha","dsh":{}}')
  const result = spawnSync('tar', ['-czf', '-', '-C', staging, '.'])
  if (result.error !== undefined)
    throw result.error
  cachedArchive = result.stdout
  return cachedArchive
}

function startInstance(sandbox: Sandbox, env: Record<string, string> = {}): void {
  const profile: MachineProfile = { id: MachineId(PROFILE), name: PROFILE, host: '127.0.0.1', user: 'tester', port: 22, remotePort: REMOTE_PORT, profileName: PROFILE }
  const result = spawnSync('sh', ['-c', startCommandFor(profile)], { env: childEnv(sandbox, env), encoding: 'utf8', timeout: 30_000 })
  expect(result.status, `远端实例启动失败: ${result.stderr}`).toBe(0)
}

function runSyncScript(sandbox: Sandbox, options: { shims?: string[], env?: Record<string, string>, expectedHash?: string, replaceTree?: boolean, treeHash?: string, treeVersion?: string, pluginNames?: string[] } = {}) {
  const replaceTree = options.replaceTree !== false
  const script = [...options.shims ?? [], pluginSyncApplyCommand({
    profileName: PROFILE,
    remotePort: REMOTE_PORT,
    expectedHash: options.expectedHash ?? '',
    replaceTree,
    treeHash: options.treeHash ?? HASH,
    treeVersion: options.treeVersion ?? '0.6.7',
    pluginNames: options.pluginNames ?? ['plugin-alpha'],
  })].join('\n')
  const result = spawnSync('sh', ['-c', script], {
    input: replaceTree ? archive() : Buffer.alloc(0),
    env: childEnv(sandbox, options.env),
    encoding: 'utf8',
    timeout: 60_000,
  })
  expect(result.error, '同步脚本必须能在超时内跑完').toBeUndefined()
  return result
}

async function waitForInstance(sandbox: Sandbox): Promise<{ pidFile: string, pid: number }> {
  return await vi.waitFor(() => {
    const [name] = readdirSync(join(sandbox.home, '.dsh')).filter(entry => entry.endsWith('.pid'))
    if (name === undefined)
      throw new Error('远端启动命令还没有写出 pidfile')
    const pidFile = join(sandbox.home, '.dsh', name)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(pid) && pid > 0, `pidfile 内容必须是 pid: ${pid}`).toBe(true)
    return { pidFile, pid }
  }, { timeout: 5000 })
}

function processAlive(pid: number): boolean {
  return spawnSync('sh', ['-c', 'kill -0 "$1" 2>/dev/null', 'sh', String(pid)]).status === 0
}

function rmShim(sandbox: Sandbox, pidFile?: string): string {
  const log = posix(join(sandbox.logs, 'rm.log'))
  const watch = pidFile === undefined
    ? ''
    : `  if [ -f '${posix(pidFile)}' ]; then
    if kill -0 "$(cat '${posix(pidFile)}')" 2>/dev/null; then printf 'alive\\n' >> '${log}'; else printf 'dead\\n' >> '${log}'; fi
  fi
`
  return `rm() {
  printf '%s\\n' "$*" >> '${log}'
${watch}  case "$*" in
    *.old*) printf 'rm: cannot remove: Device or resource busy\\n' >&2; return 1 ;;
  esac
  command rm "$@"
}`
}

function pkillShim(sandbox: Sandbox): string {
  const log = posix(join(sandbox.logs, 'pkill.log'))
  return `pkill() {
  printf '%s\\n' "$*" >> '${log}'
  return 0
}`
}

function profileStateOf(sandbox: Sandbox, profile = PROFILE): string | undefined {
  const path = join(sandbox.home, '.dsh-desktop', 'profiles-sync', profile)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined
}

function markerOf(sandbox: Sandbox): PluginSyncMarker | undefined {
  const text = spawnSync('sh', ['-c', pluginSyncMarkerCommand()], { env: childEnv(sandbox), encoding: 'utf8' }).stdout.trim()
  if (text === '')
    return undefined
  return JSON.parse(text) as PluginSyncMarker
}

function livenessOf(sandbox: Sandbox): string[] {
  const log = join(sandbox.logs, 'rm.log')
  if (!existsSync(log))
    return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line === 'alive' || line === 'dead')
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugins-sync-scratch-'))
  scratchDirs.push(dir)
  return dir
}

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(ensureDirectory(dir), 'package.json'), JSON.stringify(manifest))
}

/** 造一份安装目录：与插件目录同级的资源清单 + `node_modules`。 */
function createResources(options: { manifest?: string, plugins: string[], legacy?: string[] }): string {
  const resources = ensureDirectory(join(scratch(), 'resources'))
  const modules = ensureDirectory(join(resources, 'node_modules'))
  writePackage(join(modules, 'dsh-tauri-remote'), { name: 'dsh-tauri-remote', version: '0.6.7', dsh: {} })
  writePackage(join(modules, 'ssh2'), { name: 'ssh2', version: '1.16.0' })
  for (const name of [...options.plugins, ...options.legacy ?? []])
    writePackage(join(modules, name), { name, dsh: {} })
  if (options.manifest !== undefined)
    writeFileSync(join(resources, 'manifest.jsonc'), options.manifest)
  return resources
}

function runWireScript(options: { base: string, profilePkg: string, statePath: string, allowlist: string[] }) {
  const script = join(scratch(), '_wire.js')
  writeFileSync(script, WIRE_SCRIPT)
  return spawnSync(process.execPath, [script, options.profilePkg, options.base, options.statePath, HASH, JSON.stringify(options.allowlist)], { encoding: 'utf8' })
}

afterEach(() => {
  for (const pid of startedPids.splice(0))
    spawnSync('sh', ['-c', 'kill -9 "$1" 2>/dev/null || true', 'sh', String(pid)])
  for (const sandbox of sandboxes.splice(0))
    rmSync(dirname(sandbox.home), { recursive: true, force: true, maxRetries: 3 })
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  rmSync(staging, { recursive: true, force: true })
  staging = ''
  cachedArchive = undefined
  vi.restoreAllMocks()
})

describe('捆绑插件内容哈希', () => {
  it('内容相同、文件时间不同的两份树哈希相同', () => {
    const left = mkdtempSync(join(tmpdir(), 'dsh-bundle-hash-'))
    const right = mkdtempSync(join(tmpdir(), 'dsh-bundle-hash-'))
    try {
      for (const root of [left, right]) {
        writeFileSync(join(ensureDirectory(join(root, 'plugin-alpha')), 'package.json'), '{"name":"plugin-alpha"}')
      }
      const early = new Date('2026-01-01T00:00:00Z')
      const late = new Date('2026-06-01T00:00:00Z')
      utimesSync(join(left, 'plugin-alpha', 'package.json'), early, early)
      utimesSync(join(right, 'plugin-alpha', 'package.json'), late, late)

      expect(bundleContentHash(left)).toBe(bundleContentHash(right))
    }
    finally {
      rmSync(left, { recursive: true, force: true })
      rmSync(right, { recursive: true, force: true })
    }
  })

  it('内容不同的两份树哈希不同', () => {
    const left = mkdtempSync(join(tmpdir(), 'dsh-bundle-hash-'))
    const right = mkdtempSync(join(tmpdir(), 'dsh-bundle-hash-'))
    try {
      writeFileSync(join(ensureDirectory(join(left, 'plugin-alpha')), 'package.json'), '{"name":"plugin-alpha"}')
      writeFileSync(join(ensureDirectory(join(right, 'plugin-alpha')), 'package.json'), '{"name":"plugin-beta"}')

      expect(bundleContentHash(left)).not.toBe(bundleContentHash(right))
    }
    finally {
      rmSync(left, { recursive: true, force: true })
      rmSync(right, { recursive: true, force: true })
    }
  })
})

describe('远端捆绑插件换树与接线怎么排', () => {
  it('远端还没有部署过捆绑插件时要换树也要接线', () => {
    const plan = planPluginSync(undefined, OURS, undefined, NAMES)

    expect(plan.replaceTree).toBe(true)
    expect(plan.wireProfile).toBe(true)
  })

  it('远端已经是这份且本档案接过线时什么都不做', () => {
    const plan = planPluginSync({ hash: HASH, version: '0.6.7' }, OURS, WIRED, NAMES)

    expect(plan.replaceTree).toBe(false)
    expect(plan.wireProfile).toBe(false)
  })

  it('远端已经是这份但本档案没接过线时只补接线', () => {
    const plan = planPluginSync({ hash: HASH, version: '0.6.7' }, OURS, undefined, NAMES)

    expect(plan.replaceTree, '远端这份已经是本机这份，不该再换一遍').toBe(false)
    expect(plan.wireProfile, '本档案还没接过线，必须补上').toBe(true)
  })

  it('远端这份没变但插件名单变了，也要重新接线', () => {
    const plan = planPluginSync({ hash: HASH, version: '0.6.7' }, OURS, wiringStateOf(HASH, ['plugin-alpha', 'plugin-beta']), NAMES)

    expect(plan.replaceTree).toBe(false)
    expect(plan.wireProfile, '名单变了必须重新接线，否则旧插件不会从档案解绑').toBe(true)
  })

  it('远端由更新版本的桌面部署时本机不换树', () => {
    const plan = planPluginSync({ hash: 'other-hash', version: '0.6.8' }, OURS, wiringStateOf('other-hash', NAMES), NAMES)

    expect(plan.replaceTree).toBe(false)
    expect(plan.wireProfile).toBe(false)
    expect(plan.reason).toContain('0.6.8')
  })

  it('远端由更新版本的桌面部署但本档案没接过线时只补接线，不动远端那份', () => {
    const plan = planPluginSync({ hash: 'other-hash', version: '0.6.8' }, OURS, undefined, NAMES)

    expect(plan.replaceTree).toBe(false)
    expect(plan.wireProfile).toBe(true)
    expect(plan.treeHash, '接线要接到远端现在这份上').toBe('other-hash')
  })

  it('本机版本更新时换树并接线', () => {
    const plan = planPluginSync({ hash: 'other-hash', version: '0.6.6' }, OURS, undefined, NAMES)

    expect(plan.replaceTree).toBe(true)
    expect(plan.wireProfile).toBe(true)
    expect(plan.treeHash).toBe(HASH)
  })

  it('同一版本时按内容哈希定胜负，两端算出同一个结果', () => {
    expect(planPluginSync({ hash: 'aaaa', version: '0.6.7' }, OURS, undefined, NAMES).replaceTree).toBe(true)
    expect(planPluginSync({ hash: 'zzzz', version: '0.6.7' }, OURS, undefined, NAMES).replaceTree).toBe(false)
  })
})

const RESOURCE_MANIFEST = `{
  "plugins": {
    // 已弃用的包：旧版本部署留下的残留
    "depercated": ["dsh-tauri-panel",],
    "built-in": [
      { "id": "dsh-tauri", "spec": "dsh-tauri" },
      { "id": "dsh-tauri-ui", "spec": "dsh-tauri-ui" },
      { "id": "dsh-tauri-model", "spec": "dsh-tauri-model@0.3.0" },
      { "id": "dsh-tauri-archive", "spec": "dsh-tauri-archive" },
      { "id": "dsh-tauri-remote", "spec": "dsh-tauri-remote" },
      { "id": "dsh-tauri-pet", "spec": "dsh-tauri-pet" },
    ],
  },
}
`

describe('捆绑插件集合按资源清单收敛', () => {
  it('只接清单声明的内置插件，插件目录里旧版本残留的包不接', () => {
    const resources = createResources({
      manifest: RESOURCE_MANIFEST,
      plugins: ['dsh-tauri', 'dsh-tauri-ui', 'dsh-tauri-model', 'dsh-tauri-pet'],
      legacy: ['dsh-tauri-panel', 'dsh-tauri-ssh-ui'],
    })

    const tree = findBundledPluginsTree(join(resources, 'node_modules', 'dsh-tauri-remote'))

    expect(tree?.pluginNames).toEqual(['dsh-tauri', 'dsh-tauri-model', 'dsh-tauri-ui'])
  })

  it('只在发起端成立的插件不接进远端档案', () => {
    const resources = createResources({
      manifest: RESOURCE_MANIFEST,
      plugins: ['dsh-tauri', 'dsh-tauri-pet'],
    })

    const tree = findBundledPluginsTree(join(resources, 'node_modules', 'dsh-tauri-remote'))

    expect(tree?.pluginNames).not.toContain('dsh-tauri-pet')
    expect(tree?.pluginNames).not.toContain('dsh-tauri-remote')
  })

  it('清单里的注释与尾逗号都能解析', () => {
    const resources = createResources({
      manifest: `{
  "plugins": {
    "built-in": [
      { "spec": "dsh-tauri" }, // 内置
      { "spec": "dsh-tauri-ui" }, /* 另一个 */
    ],
  },
}`,
      plugins: ['dsh-tauri', 'dsh-tauri-ui'],
    })

    expect(findBundledPluginsTree(join(resources, 'node_modules', 'dsh-tauri-remote'))?.pluginNames).toEqual(['dsh-tauri', 'dsh-tauri-ui'])
  })

  it('相邻的字符串条目之间的逗号不能被当成尾逗号删掉', () => {
    const resources = createResources({
      manifest: `{ "plugins": { "built-in": ["dsh-tauri", "dsh-tauri-ui"] } }`,
      plugins: ['dsh-tauri', 'dsh-tauri-ui'],
    })

    expect(findBundledPluginsTree(join(resources, 'node_modules', 'dsh-tauri-remote'))?.pluginNames).toEqual(['dsh-tauri', 'dsh-tauri-ui'])
  })

  it('清单缺失时不把带 dsh 字段的目录当成捆绑插件', () => {
    const resources = createResources({ plugins: ['dsh-tauri'], legacy: ['dsh-tauri-panel'] })

    expect(findBundledPluginsTree(join(resources, 'node_modules', 'dsh-tauri-remote'))).toBeUndefined()
  })

  it('接线脚本收到的就是清单收敛后的插件名', () => {
    const script = pluginSyncApplyCommand({
      profileName: PROFILE,
      remotePort: REMOTE_PORT,
      expectedHash: '',
      replaceTree: true,
      treeHash: HASH,
      treeVersion: '0.6.7',
      pluginNames: ['dsh-tauri', 'dsh-tauri-ui'],
    })

    expect(script).toContain(`'["dsh-tauri","dsh-tauri-ui"]'`)
  })
})

describe.skipIf(!SYMLINK_AVAILABLE)('接线脚本只接清单里的内置插件', () => {
  it('旧版本残留的插件从远端档案解绑', () => {
    const home = ensureDirectory(join(scratch(), 'home'))
    const base = ensureDirectory(join(home, '.dsh-desktop', 'plugins', 'node_modules'))
    for (const name of ['dsh-tauri', 'dsh-tauri-ui', 'dsh-tauri-panel'])
      writePackage(join(base, name), { name, dsh: {} })
    writePackage(join(base, 'h3'), { name: 'h3' })
    const profileDir = ensureDirectory(join(home, '.dsh', 'profiles', PROFILE))
    const profilePkg = join(profileDir, 'package.json')
    writeFileSync(profilePkg, JSON.stringify({
      name: 'dsh-remote',
      dependencies: {
        'dsh-tauri': `link:${join(base, 'dsh-tauri')}`,
        'dsh-tauri-panel': `link:${join(base, 'dsh-tauri-panel')}`,
      },
      dsh: { profile: { bundles: ['dsh-tauri', 'dsh-tauri-panel'] } },
    }))

    const result = runWireScript({
      base,
      profilePkg,
      statePath: join(home, '.dsh-desktop', 'profiles-sync', PROFILE),
      allowlist: ['dsh-tauri', 'dsh-tauri-ui'],
    })

    expect(result.status, String(result.stderr)).toBe(0)
    const doc = JSON.parse(readFileSync(profilePkg, 'utf8')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
    expect(Object.keys(doc.dependencies).sort()).toEqual(['dsh-tauri', 'dsh-tauri-ui'])
    expect([...doc.dsh.profile.bundles].sort()).toEqual(['dsh-tauri', 'dsh-tauri-ui'])
    expect(existsSync(join(profileDir, 'node_modules', 'dsh-tauri-ui'))).toBe(true)
    expect(existsSync(join(profileDir, 'node_modules', 'dsh-tauri-panel')), '旧包必须从档案解绑').toBe(false)
  })

  it('远端这份目录里没有的插件不接线', () => {
    const home = ensureDirectory(join(scratch(), 'home'))
    const base = ensureDirectory(join(home, '.dsh-desktop', 'plugins', 'node_modules'))
    writePackage(join(base, 'dsh-tauri'), { name: 'dsh-tauri', dsh: {} })
    const profileDir = ensureDirectory(join(home, '.dsh', 'profiles', PROFILE))
    const profilePkg = join(profileDir, 'package.json')
    writeFileSync(profilePkg, JSON.stringify({ name: 'dsh-remote' }))

    const result = runWireScript({
      base,
      profilePkg,
      statePath: join(home, '.dsh-desktop', 'profiles-sync', PROFILE),
      allowlist: ['dsh-tauri', 'dsh-tauri-archive'],
    })

    expect(result.status, String(result.stderr)).toBe(0)
    const doc = JSON.parse(readFileSync(profilePkg, 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(doc.dependencies)).toEqual(['dsh-tauri'])
  })
})

describe.skipIf(!SHELL_AVAILABLE)('plugins-sync 远端换树脚本', () => {
  it('换树后新树生效、写 marker 并输出 PLUGINS_SYNCED', () => {
    const sandbox = createSandbox()

    const result = runSyncScript(sandbox)

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PLUGINS_SYNCED')
    expect(readFileSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json'), 'utf8')).toBe('{"name":"plugin-alpha","dsh":{}}')
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'legacy.txt')), '旧树必须整体换走').toBe(false)
    expect(markerOf(sandbox)).toEqual({ hash: HASH, version: '0.6.7' })
  })

  it('同步先停掉 pidfile 记录的旧实例', async () => {
    const sandbox = createSandbox()
    startInstance(sandbox)
    const { pid } = await waitForInstance(sandbox)
    startedPids.push(pid)
    expect(processAlive(pid), '旧实例必须先真的跑起来').toBe(true)

    const result = runSyncScript(sandbox)

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    expect(processAlive(pid), '同步后旧实例必须已退出').toBe(false)
    expect(markerOf(sandbox)).toEqual({ hash: HASH, version: '0.6.7' })
  })

  it('rm 对旧树返回非 0 时同步仍走完并输出 PLUGINS_SYNCED', () => {
    const sandbox = createSandbox()

    const result = runSyncScript(sandbox, { shims: [rmShim(sandbox)] })

    expect(result.status, `旧树删不掉不得中止同步: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PLUGINS_SYNCED')
    expect(readFileSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json'), 'utf8')).toBe('{"name":"plugin-alpha","dsh":{}}')
    expect(markerOf(sandbox)).toEqual({ hash: HASH, version: '0.6.7' })
  })

  it('旧树删不掉时下次同步仍能重跑', () => {
    const sandbox = createSandbox()
    const shims = [rmShim(sandbox)]
    expect(runSyncScript(sandbox, { shims }).status).toBe(0)

    // 第二次：远端标记已经是上一次写的那份，判定要带着它。
    const second = runSyncScript(sandbox, { shims, expectedHash: HASH })

    expect(second.status, `残留旧树不得阻塞下次同步: ${second.stderr}`).toBe(0)
    expect(second.stdout).toContain('PLUGINS_SYNCED')
  })

  it('删旧树之前旧实例必须已经停掉', async () => {
    const sandbox = createSandbox()
    startInstance(sandbox)
    const { pidFile, pid } = await waitForInstance(sandbox)
    startedPids.push(pid)

    const result = runSyncScript(sandbox, { shims: [rmShim(sandbox, pidFile)] })

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    expect(livenessOf(sandbox).at(-1), '换树那一刻旧实例必须已退出').toBe('dead')
  })

  it('换树后接线失败时不写 marker，下次同步仍会重跑', () => {
    const sandbox = createSandbox()

    const result = runSyncScript(sandbox, { env: { STUB_WIRE_STATUS: '1' } })

    expect(result.status, '接线失败必须让同步整体失败').not.toBe(0)
    expect(result.stdout).not.toContain('PLUGINS_SYNCED')
    expect(markerOf(sandbox), '未完成同步不得留下 marker').toBeUndefined()
  })

  it('停实例的 pkill 模式命中真实启动 argv 且不误伤别的端口', async () => {
    const sandbox = createSandbox()
    const argvLog = join(sandbox.logs, 'argv.log')
    startInstance(sandbox, { STUB_ARGV_LOG: posix(argvLog), STUB_NODE_EXIT: '1' })
    // 文件可能已被创建但内容还没落盘（stub 先 open 后 write），只等「存在」会读到空串。
    const argv = await vi.waitFor(() => {
      const text = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim() : ''
      if (text === '')
        throw new Error('远端实例还没有把 argv 写进日志')
      return text
    }, { timeout: 15_000 })
    expect(argv).toContain(`--profile ${PROFILE}`)

    const result = runSyncScript(sandbox, { shims: [pkillShim(sandbox)], env: { STUB_NODE_EXIT: '1' } })

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    const invocation = readFileSync(join(sandbox.logs, 'pkill.log'), 'utf8').trim()
    expect(invocation, 'pkill 必须以 -f 全命令行匹配').toMatch(/^-f\s+/u)
    const pattern = invocation.replace(/^-f\s+/u, '')
    expect(new RegExp(pattern).test(argv), `${pattern} 必须命中 ${argv}`).toBe(true)
    expect(new RegExp(pattern).test(argv.replaceAll(`--port ${REMOTE_PORT}`, `--port ${REMOTE_PORT + 1}`)), '不得误杀别的端口上的实例').toBe(false)
    expect(new RegExp(pattern).test(argv.replaceAll(`--port ${REMOTE_PORT}`, `--port ${REMOTE_PORT}1`)), '端口必须按完整数字匹配').toBe(false)
  })

  it('停实例的匹配串在运行期拼装，脚本不会命中自己', () => {
    // 匹配串若在生成期展开，脚本自身的命令行就包含它，`pkill -f` 会在 Linux 上
    // 把正在执行同步的 shell 一起杀掉（同步失败且退出码为空）。
    const script = pluginSyncApplyCommand({
      profileName: PROFILE,
      remotePort: REMOTE_PORT,
      expectedHash: '',
      replaceTree: true,
      treeHash: HASH,
      treeVersion: '0.6.7',
      pluginNames: ['plugin-alpha'],
    })

    expect(script).not.toContain(`bin.js --profile ${PROFILE} --host 127.0.0.1 --port ${REMOTE_PORT}`)
  })

  describe.skipIf(!PS_ARGS_AVAILABLE)('pidfile 过期时按命令行确认身份', () => {
    it('pidfile 记录的 PID 已被无关进程复用时不得停掉它', () => {
      const sandbox = createSandbox()
      const unrelated = spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
      const pid = Number(unrelated.stdout.trim())
      expect(Number.isInteger(pid) && pid > 0, `需要先拿到一个无关进程: ${unrelated.stderr}`).toBe(true)
      startedPids.push(pid)
      writeFileSync(join(sandbox.home, remotePidfile(REMOTE_PORT)), `${pid}\n`)

      const result = runSyncScript(sandbox)

      expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
      expect(processAlive(pid), '命令行不匹配的进程必须保留').toBe(true)
      expect(markerOf(sandbox)).toEqual({ hash: HASH, version: '0.6.7' })
    })
  })

  it('别的写入方正在准备的暂存目录不能删', () => {
    const sandbox = createSandbox()
    const others = join(sandbox.home, '.dsh-desktop', `plugins.new.${process.pid}-1`)
    ensureDirectory(others)

    const result = runSyncScript(sandbox)

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    expect(existsSync(others), '写入方还活着的暂存目录不能被删掉').toBe(true)
  })

  it('只补接线时不上传插件包，也不换目录', () => {
    const wiring = pluginSyncApplyCommand({
      profileName: PROFILE,
      remotePort: REMOTE_PORT,
      expectedHash: 'other-hash',
      replaceTree: false,
      treeHash: 'other-hash',
      treeVersion: '0.6.8',
      pluginNames: ['plugin-alpha'],
    })

    expect(wiring, '不换树时不该收插件包').not.toContain('tar -xzf')
    expect(wiring, '不换树时不该动插件目录').not.toContain('mv "$NEW" "$BASE"')
    expect(wiring, '接线脚本要用当前这份实现').toContain('DSH_WIRE_EOF')
  })

  it('只补接线时不换远端那份插件目录', () => {
    const sandbox = createSandbox()
    // 远端这份是别的桌面部署的：本机只给档案补接线。
    writeFileSync(join(ensureDirectory(join(sandbox.plugins, 'node_modules', 'plugin-alpha')), 'package.json'), '{"name":"plugin-alpha","dsh":{}}')
    writeFileSync(join(sandbox.plugins, '.sync.json'), JSON.stringify({ hash: 'other-hash', version: '0.6.8' }))

    const result = runSyncScript(sandbox, { replaceTree: false, expectedHash: 'other-hash', treeHash: 'other-hash', treeVersion: '0.6.8' })

    expect(result.status, `补接线必须成功: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PLUGINS_SYNCED')
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'legacy.txt')), '不换树时远端那份不能被动').toBe(true)
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json')), '不换树时远端那份不能被换掉').toBe(true)
    const profilePkg = JSON.parse(readFileSync(join(sandbox.home, '.dsh', 'profiles', PROFILE, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(profilePkg.dependencies?.['plugin-alpha'], '档案要接到远端这份插件目录上').toContain('plugin-alpha')
    expect(markerOf(sandbox)).toEqual({ hash: 'other-hash', version: '0.6.8' })
    expect(profileStateOf(sandbox), '接线状态按档案单独记').toBe(wiringStateOf('other-hash', NAMES))
  })

  it('每个档案的接线状态各记各的，互不影响', () => {
    const sandbox = createSandbox()
    // 另一个档案已经接过线：它接的是哪一份，不能被本档案的同步改掉。
    const otherState = ensureDirectory(join(sandbox.home, '.dsh-desktop', 'profiles-sync'))
    writeFileSync(join(otherState, 'other-profile'), 'other-hash\n')
    writeFileSync(join(sandbox.plugins, '.sync.json'), JSON.stringify({ hash: HASH, version: '0.6.7' }))

    const result = runSyncScript(sandbox, { expectedHash: HASH })

    expect(result.status, `同步必须成功: ${result.stderr}`).toBe(0)
    expect(profileStateOf(sandbox)).toBe(WIRED)
    expect(profileStateOf(sandbox, 'other-profile'), '别的档案的接线状态不能被动').toBe('other-hash')
  })

  it('拿到占用声明时远端标记已经变了，这次同步必须作废', () => {
    const sandbox = createSandbox()
    // 远端已经被另一台桌面换过：判定时读到的是旧标记。
    writeFileSync(join(sandbox.plugins, '.sync.json'), JSON.stringify({ hash: 'someone-else', version: '0.6.8' }))

    const result = runSyncScript(sandbox, { expectedHash: HASH })

    expect(result.status, '标记变了就作废，交给桌面端重新判定').toBe(22)
    expect(`${result.stdout}${result.stderr}`).toContain('PLUGIN_SYNC_MARKER_CHANGED')
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json')), '判定作废时不得换树').toBe(false)
    expect(markerOf(sandbox), '判定作废时不得改远端标记').toEqual({ hash: 'someone-else', version: '0.6.8' })
  })

  it('远端有别的操作占着活动槽位时同步必须失败', () => {
    const sandbox = createSandbox()
    const claim = ensureDirectory(join(sandbox.home, '.dsh-desktop', 'tmp', 'slot-dsh.lock'))
    writeFileSync(join(claim, `claim-${process.pid}`), `${process.pid}\n`)

    const result = runSyncScript(sandbox)

    expect(result.status, '占着活动槽位时不能继续换树').not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('REMOTE_CORE_SLOT_BUSY')
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json')), '占着锁时不得换树').toBe(false)
  })

  describe.skipIf(!PKILL_AVAILABLE)('真实 pkill 兜底', () => {
    it('pidfile 缺失时按真实启动 argv 停掉旧实例', async () => {
      const sandbox = createSandbox()
      startInstance(sandbox)
      const { pidFile, pid } = await waitForInstance(sandbox)
      startedPids.push(pid)
      rmSync(pidFile)

      const result = runSyncScript(sandbox)

      expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
      await vi.waitFor(() => {
        expect(processAlive(pid), 'pkill 必须命中真实启动 argv').toBe(false)
      }, { timeout: 5000 })
    })
  })
})
