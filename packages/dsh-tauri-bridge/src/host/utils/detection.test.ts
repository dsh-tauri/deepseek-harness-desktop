import type { ChildProcess } from 'node:child_process'
import type { DetectionOptions } from './detection'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectBackend, nativeEnvironment, resolveNativeCommand } from './detection'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

interface ProbePlan {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  hold?: boolean
  closeOnKill?: boolean
  killReturn?: boolean
  killError?: Error
}

class ProbeFixture extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private closed = false
  readonly kill = vi.fn(() => {
    if (this.plan.killError)
      throw this.plan.killError
    if (this.plan.closeOnKill !== false)
      this.finish(null)
    return this.plan.killReturn ?? true
  })

  constructor(private readonly plan: ProbePlan) {
    super()
  }

  get child(): ChildProcess {
    return this as unknown as ChildProcess
  }

  run(): void {
    if (this.plan.error) {
      this.emit('error', this.plan.error)
      return
    }
    if (this.plan.stdout)
      this.stdout.write(this.plan.stdout)
    if (!this.closed && this.plan.stderr)
      this.stderr.write(this.plan.stderr)
    if (!this.closed && !this.plan.hold)
      this.finish(this.plan.code ?? 0)
  }

  finish(code: number | null): void {
    if (this.closed)
      return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, null)
  }
}

const spawnMock = vi.mocked(spawn)
let root: string
let plans: ProbePlan[]
let probes: ProbeFixture[]
let waiters: { index: number, resolve: (probe: ProbeFixture) => void }[]

function nextProbe(index = 0): Promise<ProbeFixture> {
  if (probes[index])
    return Promise.resolve(probes[index])
  return new Promise(resolveProbe => waiters.push({ index, resolve: resolveProbe }))
}

async function file(relativePath: string, content = ''): Promise<string> {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { mode: 0o755 })
  return path
}

function options(path = root, rest: DetectionOptions = {}): DetectionOptions {
  return { platform: 'win32', arch: 'x64', env: { Path: path, HOME: root, USERPROFILE: root }, ...rest }
}

async function codexPackage(nativeLocation: 'optional' | 'vendor' = 'optional', target = 'x86_64-pc-windows-msvc'): Promise<{ entry: string, native: string }> {
  const packageRoot = 'node_modules/@openai/codex'
  const entry = await file(`${packageRoot}/bin/codex.js`, '#!/usr/bin/env node\n')
  await file(`${packageRoot}/package.json`, JSON.stringify({ name: '@openai/codex', version: '0.147.0' }))
  const vendor = nativeLocation === 'optional' ? `${packageRoot}/node_modules/@openai/codex-win32-x64/vendor` : `${packageRoot}/vendor`
  if (nativeLocation === 'optional')
    await file(`${packageRoot}/node_modules/@openai/codex-win32-x64/package.json`, JSON.stringify({ name: '@openai/codex', version: '0.147.0-win32-x64' }))
  const native = await file(`${vendor}/${target}/bin/${target.includes('windows') ? 'codex.exe' : 'codex'}`)
  return { entry, native }
}

async function claudePackage(): Promise<string> {
  const entry = await file('node_modules/@anthropic-ai/claude-code/cli.js', '#!/usr/bin/env node\n')
  await file('node_modules/@anthropic-ai/claude-code/package.json', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.287' }))
  return entry
}

function healthyCodex(auth: ProbePlan = { stderr: 'Logged in using ChatGPT', code: 0 }): void {
  plans = [{ stdout: 'codex-cli 0.147.0\n' }, { stdout: 'Usage: codex app-server [OPTIONS]\n' }, auth]
}

function healthyClaude(auth: ProbePlan = { stdout: '{"loggedIn":true}', code: 0 }): void {
  plans = [{ stdout: '2.1.287 (Claude Code)\n' }, { stdout: '--input-format stream-json --output-format stream-json\n' }, auth]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-bridge-detection-test-'))
  plans = []
  probes = []
  waiters = []
  spawnMock.mockReset()
  spawnMock.mockImplementation((_file, _args) => {
    const plan = plans.shift()
    if (!plan)
      throw new Error('Unexpected native probe without a protocol fixture')
    const probe = new ProbeFixture(plan)
    const index = probes.push(probe) - 1
    for (const waiter of waiters.filter(waiter => waiter.index === index)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(probe)
    }
    queueMicrotask(() => probe.run())
    return probe.child
  })
})

afterEach(async () => {
  for (const probe of probes)
    probe.finish(null)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  spawnMock.mockReset()
  const target = resolve(root)
  if (!isAbsolute(target) || dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dsh-bridge-detection-test-'))
    throw new Error('Refusing to remove a directory outside the owned detection fixture')
  await rm(target, { recursive: true, force: true })
})

describe('native command resolution', () => {
  it('prefers an explicit executable over every PATH candidate', async () => {
    const explicit = await file('chosen/codex.exe')
    await file('path/codex.exe')
    const result = await resolveNativeCommand('codex', explicit, options(join(root, 'path')))
    expect(result).toEqual({ file: await realpath(explicit), args: [], env: { Path: join(root, 'path'), HOME: root, USERPROFILE: root } })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'relative/codex.exe'])('refuses invalid explicit path %j without falling back to PATH', async (override) => {
    await file('codex.exe')
    const result = await detectBackend('codex', override, options())
    expect(result).toEqual({ detection: { id: 'codex', installed: false, auth: 'unknown', version: null, drift: false, hint: 'BRIDGE_EXECUTABLE_PATH: 请配置本机 CLI 的绝对路径。' } })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses a missing explicit executable despite a working PATH installation', async () => {
    await file('codex.exe')
    const result = await detectBackend('codex', join(root, 'missing.exe'), options())
    expect(result.detection.hint).toBe('BRIDGE_EXECUTABLE_MISSING: 配置的 CLI 不存在或不可执行。')
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prefers the first absolute PATH directory over later native executables', async () => {
    const installation = await codexPackage()
    await file('codex.ps1', '& "$basedir/node_modules/@openai/codex/bin/codex.js" $args')
    await file('later/codex.exe')
    const result = await resolveNativeCommand('codex', undefined, options(`${root};${join(root, 'later')}`))
    expect(result.file).toBe(await realpath(installation.native))
    expect(result.args).toEqual([])
  })

  it('prefers exe over npm wrappers in the same Windows PATH directory', async () => {
    const native = await file('codex.exe')
    await file('codex.cmd', 'unrecognized wrapper')
    await file('codex.ps1', 'unrecognized wrapper')
    expect((await resolveNativeCommand('codex', undefined, options())).file).toBe(await realpath(native))
  })

  it('ignores relative and empty PATH segments instead of searching the process directory', async () => {
    const native = await file('absolute/claude.exe')
    const result = await resolveNativeCommand('claude', undefined, options(`;relative;${join(root, 'absolute')};;`))
    expect(result.file).toBe(await realpath(native))
  })

  it('skips directories named like executables', async () => {
    await mkdir(join(root, 'codex.exe'))
    const native = await file('codex')
    expect((await resolveNativeCommand('codex', undefined, options())).file).toBe(await realpath(native))
  })

  it.each(['codex', 'claude'] as const)('reports absent %s without spawning a fallback engine', async (backend) => {
    const result = await detectBackend(backend, undefined, options())
    expect(result.detection).toEqual({ id: backend, installed: false, auth: 'unknown', version: null, drift: false, hint: `BRIDGE_EXECUTABLE_MISSING: 本机未安装 ${backend === 'codex' ? 'Codex' : 'Claude'} CLI，或其不在 PATH 中。` })
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(['cmd', 'ps1'])('unwraps the official Codex npm %s shim into its optional native platform package', async (extension) => {
    const installation = await codexPackage()
    const shim = await file(`codex.${extension}`, '@ECHO off\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*')
    const result = await resolveNativeCommand('codex', shim, options())
    expect(result).toEqual({ file: await realpath(installation.native), args: [], env: { Path: root, HOME: root, USERPROFILE: root } })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('uses the official embedded Codex vendor layout when no optional platform package exists', async () => {
    const installation = await codexPackage('vendor')
    expect((await resolveNativeCommand('codex', installation.entry, options())).file).toBe(await realpath(installation.native))
  })

  it.each(['cmd', 'ps1'])('unwraps the official Claude npm %s shim to Node plus its validated entrypoint', async (extension) => {
    const entry = await claudePackage()
    const shim = await file(`claude.${extension}`, 'node "%~dp0/node_modules/@anthropic-ai/claude-code/cli.js" %*')
    const result = await resolveNativeCommand('claude', shim, options())
    expect(result).toEqual({ file: process.execPath, args: [await realpath(entry)], env: { Path: root, HOME: root, USERPROFILE: root } })
  })

  it.each(['cmd', 'ps1'])('resolves the official Claude native npm %s entrypoint without invoking a shell', async (extension) => {
    const native = await file('node_modules/@anthropic-ai/claude-code/bin/claude.exe')
    await file('node_modules/@anthropic-ai/claude-code/package.json', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.295', bin: { claude: 'bin/claude.exe' } }))
    const shim = await file(`claude.${extension}`, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*')
    const result = await resolveNativeCommand('claude', shim, options())
    expect(result).toEqual({ file: await realpath(native), args: [], env: { Path: root, HOME: root, USERPROFILE: root } })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an impersonated native Claude package before using its executable', async () => {
    await file('node_modules/@anthropic-ai/claude-code/bin/claude.exe')
    await file('node_modules/@anthropic-ai/claude-code/package.json', '{"name":"not-anthropic"}')
    const shim = await file('claude.cmd', '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*')
    await expect(resolveNativeCommand('claude', shim, options())).rejects.toThrow('BRIDGE_PACKAGE_MISMATCH: CLI 包装器不是所选内核的官方安装。')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses an unrecognized wrapper instead of falling back to another PATH installation', async () => {
    const shim = await file('chosen/codex.cmd', '@ECHO off\ncustom-command %*')
    await file('codex.exe')
    await expect(resolveNativeCommand('codex', shim, options())).rejects.toThrow('BRIDGE_SHIM_UNSUPPORTED: 此命令包装器无法安全解析，请配置原生可执行文件路径。')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a package impersonating the selected official CLI', async () => {
    const entry = await file('node_modules/@anthropic-ai/claude-code/cli.js')
    await file('node_modules/@anthropic-ai/claude-code/package.json', '{"name":"not-the-official-package"}')
    await expect(resolveNativeCommand('claude', entry, options())).rejects.toThrow('BRIDGE_PACKAGE_MISMATCH: CLI 包装器不是所选内核的官方安装。')
  })

  it('rejects an oversized wrapper before attempting a native probe', async () => {
    const shim = await file('claude.cmd', 'x'.repeat(128 * 1024 + 1))
    const result = await detectBackend('claude', shim, options())
    expect(result.detection.hint).toBe('BRIDGE_SHIM_TOO_LARGE: CLI 包装器文件异常。')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('fails closed when an official Codex installation lacks its native binary', async () => {
    const entry = await file('node_modules/@openai/codex/bin/codex.js')
    await file('node_modules/@openai/codex/package.json', '{"name":"@openai/codex"}')
    await expect(resolveNativeCommand('codex', entry, options())).rejects.toThrow('BRIDGE_EXECUTABLE_MISSING: 官方 CLI 安装缺少原生可执行文件，请重新安装。')
  })

  it.each([
    ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
  ] as const)('resolves the official %s %s target triple without running a shim', async (platform, arch, target) => {
    const installation = await codexPackage('vendor', target)
    expect((await resolveNativeCommand('codex', installation.entry, options(root, { platform, arch }))).file).toBe(await realpath(installation.native))
  })

  it('refuses unsupported Codex architectures without substituting another native binary', async () => {
    const installation = await codexPackage('vendor')
    await expect(resolveNativeCommand('codex', installation.entry, options(root, { arch: 'riscv64' }))).rejects.toThrow('BRIDGE_PLATFORM_UNSUPPORTED: 此平台没有可用的本机 Codex CLI。')
  })
})

describe('native environment isolation', () => {
  it('removes case-insensitive DSH and nested-runtime markers while retaining native credentials', () => {
    const input = Object.freeze({ Path: root, DSH_HOME: 'outer-home', dsh_api_token: 'outer-token', Dsh_Foo: 'outer', CLAUDECODE: '1', claude_code_entrypoint: 'sdk', CODEX_THREAD_ID: 'outer-thread', codex_internal_originator_override: 'outer', node_options: '--inspect', OPENAI_API_KEY: 'native-test-key', ANTHROPIC_API_KEY: 'native-test-key', HTTPS_PROXY: 'http://native-proxy' })
    expect(nativeEnvironment(input)).toEqual({ Path: root, OPENAI_API_KEY: 'native-test-key', ANTHROPIC_API_KEY: 'native-test-key', HTTPS_PROXY: 'http://native-proxy' })
    expect(input.DSH_HOME).toBe('outer-home')
    expect(input.node_options).toBe('--inspect')
  })

  it('passes a full scrubbed environment and direct argv without shell execution to every probe', async () => {
    const entry = await claudePackage()
    healthyClaude()
    const result = await detectBackend('claude', entry, options(root, { env: { Path: root, HOME: root, DSH_TOKEN: 'outer', CLAUDECODE: '1', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'native-test-key' } }))
    expect(result.detection.auth).toBe('ok')
    expect(spawnMock.mock.calls).toEqual([
      [process.execPath, [await realpath(entry), '--version'], { env: { Path: root, HOME: root, ANTHROPIC_API_KEY: 'native-test-key' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }],
      [process.execPath, [await realpath(entry), '--help'], { env: { Path: root, HOME: root, ANTHROPIC_API_KEY: 'native-test-key' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }],
      [process.execPath, [await realpath(entry), 'auth', 'status', '--json'], { env: { Path: root, HOME: root, ANTHROPIC_API_KEY: 'native-test-key' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }],
    ])
  })
})

describe('backend detection capability probes', () => {
  it('returns Codex installation, version, authentication and the exact native command', async () => {
    const native = await file('codex.exe')
    healthyCodex()
    const result = await detectBackend('codex', undefined, options())
    expect(result).toEqual({ detection: { id: 'codex', installed: true, auth: 'ok', version: '0.147.0', drift: false, hint: null }, command: { file: await realpath(native), args: [], env: { Path: root, HOME: root, USERPROFILE: root } } })
    expect(spawnMock.mock.calls.map(([, args]) => args)).toEqual([['--version'], ['app-server', '--help'], ['login', 'status']])
  })

  it.each(['0.0.1', '99.9.9-preview.7'])('does not impose a hard version gate on an advertised capable CLI %s', async (version) => {
    await file('codex.exe')
    healthyCodex()
    plans[0] = { stdout: `codex-cli ${version}\n` }
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: true, auth: 'ok', version, drift: false, hint: null })
  })

  it('rejects a failed version probe without trying another installed executable', async () => {
    await file('chosen/codex.exe')
    await file('later/codex.exe')
    plans = [{ stderr: 'native installation is broken', code: 2 }]
    const result = await detectBackend('codex', undefined, options(`${join(root, 'chosen')};${join(root, 'later')}`))
    expect(result.detection).toEqual({ id: 'codex', installed: false, auth: 'unknown', version: null, drift: false, hint: 'BRIDGE_PROBE_FAILED: CLI 版本探测失败，请在终端检查该安装。' })
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('rejects unrecognizable version output before capability or authentication probes', async () => {
    await file('codex.exe')
    plans = [{ stdout: 'codex-cli development build\n' }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection.hint).toBe('BRIDGE_VERSION_UNRECOGNIZED: CLI 未返回可识别版本。')
    expect(result.detection.version).toBeNull()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('marks unsupported Codex app-server as drift without returning an executable capability', async () => {
    await file('codex.exe')
    plans = [{ stdout: 'codex-cli 0.147.0' }, { stderr: 'unknown subcommand app-server', code: 2 }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: false, auth: 'unknown', version: '0.147.0', drift: true, hint: 'BRIDGE_PROTOCOL_UNAVAILABLE: 本机 CLI 不支持所需桥接协议，请更新 CLI。' })
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('rejects Claude help missing stream-json despite a successful help exit', async () => {
    await file('claude.exe')
    plans = [{ stdout: '2.1.287 (Claude Code)' }, { stdout: '--output-format text\n' }]
    const result = await detectBackend('claude', undefined, options())
    expect(result.detection.installed).toBe(false)
    expect(result.detection.drift).toBe(true)
    expect(result.detection.hint).toBe('BRIDGE_PROTOCOL_UNAVAILABLE: 本机 CLI 不支持所需桥接协议，请更新 CLI。')
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ stderr: 'Not logged in', code: 1 }, 'missing', '请先在终端运行 codex login。'],
    [{ stderr: 'Native authentication backend unavailable', code: 2 }, 'unknown', '无法确认登录状态；原生 CLI 会在连接时检查认证。'],
  ] as const)('distinguishes explicit missing Codex auth from an unavailable status probe %j', async (auth, status, hint) => {
    await file('codex.exe')
    healthyCodex(auth)
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: true, auth: status, version: '0.147.0', drift: false, hint })
    expect(result.command?.args).toEqual([])
  })

  it.each([
    ['{"loggedIn":true}', 'ok', null],
    ['{"loggedIn":false}', 'missing', '请先在终端运行 claude auth login。'],
    ['{"loggedIn":"true"}', 'unknown', '无法确认登录状态；原生 CLI 会在连接时检查认证。'],
    ['not JSON', 'unknown', '无法确认登录状态；原生 CLI 会在连接时检查认证。'],
  ] as const)('interprets Claude status payload %s without inventing an authenticated session', async (stdout, status, hint) => {
    await file('claude.exe')
    healthyClaude({ stdout, code: 0 })
    const result = await detectBackend('claude', undefined, options())
    expect(result.detection).toEqual({ id: 'claude', installed: true, auth: status, version: '2.1.287', drift: false, hint })
    expect(result.command?.args).toEqual([])
  })

  it('refuses a successful Claude authentication claim from a failed status command', async () => {
    await file('claude.exe')
    healthyClaude({ stdout: '{"loggedIn":true}', code: 2 })
    const result = await detectBackend('claude', undefined, options())
    expect(result.detection).toEqual({ id: 'claude', installed: true, auth: 'unknown', version: '2.1.287', drift: false, hint: '无法确认登录状态；原生 CLI 会在连接时检查认证。' })
    expect(result.command?.args).toEqual([])
  })

  it('keeps a proven installation when only the authentication probe emits a process error', async () => {
    await file('codex.exe')
    healthyCodex({ error: new Error('auth executable error') })
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: true, auth: 'unknown', version: '0.147.0', drift: false, hint: '无法确认登录状态；原生 CLI 会在连接时检查认证。' })
    expect(result.command?.args).toEqual([])
  })

  it('fails closed when the native version child emits an error', async () => {
    await file('codex.exe')
    plans = [{ error: new Error('EACCES') }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: false, auth: 'unknown', version: null, drift: false, hint: 'BRIDGE_PROBE_FAILED: 无法探测本机 CLI，请检查配置路径和安装。' })
    expect(result).not.toHaveProperty('command')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

describe('bounded native probes', () => {
  it.each([
    [0, 100],
    [undefined, 5_000],
    [100_000, 30_000],
  ] as const)('enforces timeout %j at the bounded deadline %i without starting another engine', async (timeoutMs, deadline) => {
    vi.useFakeTimers()
    await file('codex.exe')
    plans = [{ hold: true }]
    let settled = 0
    const pending = detectBackend('codex', undefined, options(root, { timeoutMs })).then((result) => {
      settled++
      return result
    })
    const child = await nextProbe()
    await vi.advanceTimersByTimeAsync(deadline - 1)
    expect(settled).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).detection.hint).toBe('BRIDGE_PROBE_TIMEOUT: 本机 CLI 探测超时。')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a timed-out probe even when child.kill fails and close never arrives', async () => {
    vi.useFakeTimers()
    await file('codex.exe')
    plans = [{ hold: true, closeOnKill: false, killReturn: false }]
    let result: Awaited<ReturnType<typeof detectBackend>> | undefined
    const pending = detectBackend('codex', undefined, options(root, { timeoutMs: 100 })).then(value => result = value)
    const child = await nextProbe()
    await vi.advanceTimersByTimeAsync(100)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(result?.detection.hint).toBe('BRIDGE_PROBE_TIMEOUT: 本机 CLI 探测超时。')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    child.finish(null)
    await pending
  })

  it('settles timeout rejection when native kill throws without retaining owned output listeners', async () => {
    vi.useFakeTimers()
    await file('codex.exe')
    plans = [{ hold: true, killError: new Error('EPERM') }]
    const pending = detectBackend('codex', undefined, options(root, { timeoutMs: 100 }))
    const child = await nextProbe()
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).detection.hint).toBe('BRIDGE_PROBE_TIMEOUT: 本机 CLI 探测超时。')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(() => child.emit('error', new Error('late EPERM'))).not.toThrow()
    child.stdout.write('late untrusted output')
    child.stderr.write('late stderr')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts exactly 128 KiB of ASCII stdout and stderr', async () => {
    await file('codex.exe')
    const prefix = 'codex-cli 0.147.0\n'
    plans = [{ stdout: prefix + ' '.repeat(64 * 1024 - prefix.length), stderr: ' '.repeat(64 * 1024) }, { stdout: 'Usage: codex app-server' }, { stderr: 'Logged in using ChatGPT' }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection).toEqual({ id: 'codex', installed: true, auth: 'ok', version: '0.147.0', drift: false, hint: null })
    expect(probes[0].kill).not.toHaveBeenCalled()
  })

  it('rejects combined ASCII stdout and stderr one byte beyond the probe limit', async () => {
    await file('codex.exe')
    plans = [{ stdout: 'x'.repeat(64 * 1024), stderr: 'x'.repeat(64 * 1024 + 1) }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection.hint).toBe('BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。')
    expect(result.detection.installed).toBe(false)
    expect(probes[0].kill).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('bounds multibyte UTF-8 output by bytes rather than by decoded character count', async () => {
    await file('codex.exe')
    plans = [{ stdout: '你'.repeat(43_691) }]
    const result = await detectBackend('codex', undefined, options())
    expect(result.detection.hint).toBe('BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。')
    expect(result.detection.installed).toBe(false)
    expect(probes[0].kill).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('settles an over-limit probe without waiting for an uncooperative child close', async () => {
    vi.useFakeTimers()
    await file('codex.exe')
    plans = [{ hold: true, closeOnKill: false, killReturn: false }]
    let result: Awaited<ReturnType<typeof detectBackend>> | undefined
    const pending = detectBackend('codex', undefined, options()).then(value => result = value)
    const child = await nextProbe()
    child.stdout.write('x'.repeat(128 * 1024 + 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(result?.detection.hint).toBe('BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。')
    child.finish(null)
    await pending
  })

  it('stops consuming late output after the limit instead of repeatedly killing and accumulating it', async () => {
    await file('codex.exe')
    plans = [{ hold: true, closeOnKill: false }]
    const pending = detectBackend('codex', undefined, options())
    const child = await nextProbe()
    child.stdout.write('x'.repeat(128 * 1024 + 1))
    child.stderr.write('late output'.repeat(1000))
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(() => child.emit('error', new Error('late output error'))).not.toThrow()
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.finish(null)
    expect((await pending).detection.hint).toBe('BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。')
  })

  it('keeps auth unknown when its bounded status probe times out', async () => {
    vi.useFakeTimers()
    await file('claude.exe')
    healthyClaude({ hold: true })
    const pending = detectBackend('claude', undefined, options(root, { timeoutMs: 100 }))
    const child = await nextProbe(2)
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending
    expect(result.detection).toEqual({ id: 'claude', installed: true, auth: 'unknown', version: '2.1.287', drift: false, hint: '无法确认登录状态；原生 CLI 会在连接时检查认证。' })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(result.command?.args).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears all probe deadlines after a successful detection', async () => {
    vi.useFakeTimers()
    await file('codex.exe')
    healthyCodex()
    expect((await detectBackend('codex', undefined, options())).detection.auth).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
    expect(probes.every(probe => probe.kill.mock.calls.length === 0)).toBe(true)
  })
})
