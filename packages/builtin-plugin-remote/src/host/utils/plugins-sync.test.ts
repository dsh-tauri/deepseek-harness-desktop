import type { Buffer } from 'node:buffer'
import type { MachineProfile } from '../types/index'
import type { BundledPluginsTree } from './plugins-sync'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCommandFor } from '../service/bootstrap.utils'
import { MachineId } from '../types/index'
import { pluginSyncApplyCommand, pluginSyncMarkerCommand } from './plugins-sync'

const PROFILE = 'plugins-sync-test'
const REMOTE_PORT = 41983
const HASH = 'b7e9c1f2d4a6'
const TREE: BundledPluginsTree = { root: '/unused', pluginNames: ['plugin-alpha', 'plugin-beta'] }

const SHELL_AVAILABLE = spawnSync('sh', ['-c', 'command -v tar >/dev/null 2>&1 && command -v kill >/dev/null 2>&1']).status === 0
const PKILL_AVAILABLE = spawnSync('pkill', ['-f', 'dsh-plugins-sync-probe-absent']).status === 1

const NODE_STUB = `#!/bin/sh
if [ -n "$STUB_ARGV_LOG" ]; then printf '%s\\n' "$0 $*" >> "$STUB_ARGV_LOG"; fi
case "$*" in
  *_wire.js*) printf 'wired %s\\n' "$*"; exit "\${STUB_WIRE_STATUS:-0}" ;;
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
  return { ...process.env, HOME: posix(sandbox.home), ...extra }
}

function archive(): Buffer {
  if (cachedArchive !== undefined)
    return cachedArchive
  staging = ensureDirectory(mkdtempSync(join(tmpdir(), 'dsh-plugins-sync-tree-')))
  writeFileSync(join(ensureDirectory(join(staging, 'plugin-alpha')), 'package.json'), '{"name":"plugin-alpha"}')
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

function runSyncScript(sandbox: Sandbox, options: { shims?: string[], env?: Record<string, string> } = {}) {
  const script = [...options.shims ?? [], pluginSyncApplyCommand(TREE, HASH, PROFILE, REMOTE_PORT)].join('\n')
  const result = spawnSync('sh', ['-c', script], {
    input: archive(),
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

function markerOf(sandbox: Sandbox): string {
  return spawnSync('sh', ['-c', pluginSyncMarkerCommand()], { env: childEnv(sandbox), encoding: 'utf8' }).stdout.trim()
}

function livenessOf(sandbox: Sandbox): string[] {
  const log = join(sandbox.logs, 'rm.log')
  if (!existsSync(log))
    return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line === 'alive' || line === 'dead')
}

afterEach(() => {
  for (const pid of startedPids.splice(0))
    spawnSync('sh', ['-c', 'kill -9 "$1" 2>/dev/null || true', 'sh', String(pid)])
  for (const sandbox of sandboxes.splice(0))
    rmSync(dirname(sandbox.home), { recursive: true, force: true, maxRetries: 3 })
  rmSync(staging, { recursive: true, force: true })
  staging = ''
  cachedArchive = undefined
  vi.restoreAllMocks()
})

describe.skipIf(!SHELL_AVAILABLE)('plugins-sync 远端换树脚本', () => {
  it('换树后新树生效、写 marker 并输出 PLUGINS_SYNCED', () => {
    const sandbox = createSandbox()

    const result = runSyncScript(sandbox)

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PLUGINS_SYNCED')
    expect(readFileSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json'), 'utf8')).toBe('{"name":"plugin-alpha"}')
    expect(existsSync(join(sandbox.plugins, 'node_modules', 'legacy.txt')), '旧树必须整体换走').toBe(false)
    expect(markerOf(sandbox)).toBe(HASH)
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
    expect(markerOf(sandbox)).toBe(HASH)
  })

  it('rm 对旧树返回非 0 时同步仍走完并输出 PLUGINS_SYNCED', () => {
    const sandbox = createSandbox()

    const result = runSyncScript(sandbox, { shims: [rmShim(sandbox)] })

    expect(result.status, `旧树删不掉不得中止同步: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PLUGINS_SYNCED')
    expect(readFileSync(join(sandbox.plugins, 'node_modules', 'plugin-alpha', 'package.json'), 'utf8')).toBe('{"name":"plugin-alpha"}')
    expect(markerOf(sandbox)).toBe(HASH)
  })

  it('旧树删不掉时下次同步仍能重跑', () => {
    const sandbox = createSandbox()
    const shims = [rmShim(sandbox)]
    expect(runSyncScript(sandbox, { shims }).status).toBe(0)

    const second = runSyncScript(sandbox, { shims })

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
    expect(markerOf(sandbox), '未完成同步不得留下 marker').toBe('')
  })

  it('停实例的 pkill 模式命中真实启动 argv 且不误伤别的端口', async () => {
    const sandbox = createSandbox()
    const argvLog = join(sandbox.logs, 'argv.log')
    startInstance(sandbox, { STUB_ARGV_LOG: posix(argvLog), STUB_NODE_EXIT: '1' })
    const argv = await vi.waitFor(() => {
      if (!existsSync(argvLog))
        throw new Error('远端实例还没有把 argv 写进日志')
      return readFileSync(argvLog, 'utf8').trim()
    }, { timeout: 5000 })
    expect(argv).toContain(`--profile ${PROFILE}`)

    const result = runSyncScript(sandbox, { shims: [pkillShim(sandbox)], env: { STUB_NODE_EXIT: '1' } })

    expect(result.status, `同步脚本必须成功: ${result.stderr}`).toBe(0)
    const invocation = readFileSync(join(sandbox.logs, 'pkill.log'), 'utf8').trim()
    expect(invocation, 'pkill 必须以 -f 全命令行匹配').toMatch(/^-f\s+/u)
    const pattern = invocation.replace(/^-f\s+/u, '')
    expect(new RegExp(pattern).test(argv), `${pattern} 必须命中 ${argv}`).toBe(true)
    expect(new RegExp(pattern).test(argv.replaceAll(`--port ${REMOTE_PORT}`, `--port ${REMOTE_PORT + 1}`)), '不得误杀别的端口上的实例').toBe(false)
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
