import type { Buffer } from 'node:buffer'
import type { BackendDetection } from '../../shared/types'
import type { NativeCommand } from '../backends/types'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import process from 'node:process'

export interface DetectionOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface DetectedCommand {
  detection: BackendDetection
  command?: NativeCommand
}

export function nativeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (/^(?:DSH_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|CODEX_INTERNAL_ORIGINATOR_OVERRIDE|NODE_OPTIONS)$/i.test(key))
      delete clean[key]
  }
  return clean
}

export async function resolveNativeCommand(backend: 'codex' | 'claude', override: string | undefined, options: DetectionOptions = {}): Promise<NativeCommand> {
  const platform = options.platform ?? process.platform
  const env = nativeEnvironment(options.env)
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : ['']
  let entry: string | undefined
  if (override !== undefined) {
    if (!override.trim() || !isAbsolute(override))
      throw new Error('BRIDGE_EXECUTABLE_PATH: 请配置本机 CLI 的绝对路径。')
    if (!await executable(override, platform))
      throw new Error('BRIDGE_EXECUTABLE_MISSING: 配置的 CLI 不存在或不可执行。')
    entry = override
  }
  else {
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
      if (!directory || !isAbsolute(directory))
        continue
      for (const extension of extensions) {
        const candidate = join(directory, `${backend}${extension}`)
        if (await executable(candidate, platform)) {
          entry = candidate
          break
        }
      }
      if (entry)
        break
    }
    if (!entry)
      throw new Error(`BRIDGE_EXECUTABLE_MISSING: 本机未安装 ${backend === 'codex' ? 'Codex' : 'Claude'} CLI，或其不在 PATH 中。`)
  }
  const suffix = extname(entry).toLowerCase()
  if (suffix === '.cmd' || suffix === '.ps1') {
    const text = await boundedRead(entry)
    const packagePath = backend === 'codex' ? '@openai[/\\\\]codex[/\\\\]bin[/\\\\]codex\\.js' : '@anthropic-ai[/\\\\]claude-code[/\\\\]cli\\.js'
    const match = new RegExp(`(?:node_modules[/\\\\]${packagePath})`, 'i').exec(text)
    if (!match)
      throw new Error('BRIDGE_SHIM_UNSUPPORTED: 此命令包装器无法安全解析，请配置原生可执行文件路径。')
    entry = join(dirname(entry), match[0].replace(/[\\/]/g, '/'))
  }
  entry = await realpath(entry)
  if (/\.[cm]?js$/i.test(entry)) {
    const root = backend === 'codex' ? dirname(dirname(entry)) : dirname(entry)
    const metadata = JSON.parse(await boundedRead(join(root, 'package.json'))) as { name?: string }
    const expected = backend === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'
    if (metadata.name !== expected)
      throw new Error('BRIDGE_PACKAGE_MISMATCH: CLI 包装器不是所选内核的官方安装。')
    if (backend === 'claude')
      return { file: process.execPath, args: [entry], env }
    const target = codexTarget(platform, options.arch ?? process.arch)
    const platformPackage = `@openai/codex-${platform === 'win32' ? 'win32' : platform}-${options.arch ?? process.arch}`
    let vendor = join(root, 'vendor')
    try {
      vendor = join(dirname(createRequire(join(root, 'package.json')).resolve(`${platformPackage}/package.json`)), 'vendor')
    }
    catch {}
    entry = join(vendor, target, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
  }
  if (!await executable(entry, platform))
    throw new Error('BRIDGE_EXECUTABLE_MISSING: 官方 CLI 安装缺少原生可执行文件，请重新安装。')
  return { file: await realpath(entry), args: [], env }
}

export async function detectBackend(backend: 'codex' | 'claude', override?: string, options: DetectionOptions = {}): Promise<DetectedCommand> {
  const detection: BackendDetection = { id: backend, installed: false, auth: 'unknown', version: null, drift: false, hint: null }
  try {
    const command = await resolveNativeCommand(backend, override, options)
    const timeout = options.timeoutMs ?? 5_000
    const version = await probe(command, ['--version'], timeout)
    if (version.code !== 0)
      throw new Error('BRIDGE_PROBE_FAILED: CLI 版本探测失败，请在终端检查该安装。')
    detection.version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.output)?.[0] ?? null
    if (!detection.version)
      throw new Error('BRIDGE_VERSION_UNRECOGNIZED: CLI 未返回可识别版本。')
    const help = await probe(command, backend === 'codex' ? ['app-server', '--help'] : ['--help'], timeout)
    if (help.code !== 0 || (backend === 'claude' && !/stream-json/.test(help.output))) {
      detection.drift = true
      throw new Error('BRIDGE_PROTOCOL_UNAVAILABLE: 本机 CLI 不支持所需桥接协议，请更新 CLI。')
    }
    detection.installed = true
    const auth = await probe(command, backend === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], timeout).catch(() => undefined)
    if (auth) {
      if (backend === 'codex') {
        detection.auth = auth.code === 0 ? 'ok' : /not logged in|log in|not authenticated/i.test(auth.output) ? 'missing' : 'unknown'
      }
      else {
        try {
          const status = JSON.parse(auth.output) as { loggedIn?: boolean }
          detection.auth = status.loggedIn === false ? 'missing' : auth.code === 0 && status.loggedIn === true ? 'ok' : 'unknown'
        }
        catch {}
      }
    }
    detection.hint = detection.auth === 'missing' ? `请先在终端运行 ${backend === 'codex' ? 'codex login' : 'claude auth login'}。` : detection.auth === 'unknown' ? '无法确认登录状态；原生 CLI 会在连接时检查认证。' : null
    return { detection, command }
  }
  catch (error) {
    detection.hint = error instanceof Error && error.message.startsWith('BRIDGE_') ? error.message : 'BRIDGE_PROBE_FAILED: 无法探测本机 CLI，请检查配置路径和安装。'
    return { detection }
  }
}

async function executable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile())
      return false
    await access(file, platform === 'win32' || /\.(?:cmd|ps1)$/i.test(file) ? constants.F_OK : constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

async function boundedRead(file: string): Promise<string> {
  if ((await stat(file)).size > 128 * 1024)
    throw new Error('BRIDGE_SHIM_TOO_LARGE: CLI 包装器文件异常。')
  return readFile(file, 'utf8')
}

function codexTarget(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  const os = platform === 'win32' ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : platform === 'linux' ? 'unknown-linux-musl' : undefined
  if (!cpu || !os)
    throw new Error('BRIDGE_PLATFORM_UNSUPPORTED: 此平台没有可用的本机 Codex CLI。')
  return `${cpu}-${os}`
}

async function probe(command: NativeCommand, args: string[], timeoutMs: number): Promise<{ code: number | null, output: string }> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(command.file, [...command.args, ...args], { env: command.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let bytes = 0
    let settled = false
    const timer = setTimeout(() => fail(new Error('BRIDGE_PROBE_TIMEOUT: 本机 CLI 探测超时。')), Math.min(30_000, Math.max(100, timeoutMs)))
    function cleanup(): void {
      clearTimeout(timer)
      child.stdout.off('data', collect)
      child.stderr.off('data', collect)
      child.off('close', close)
    }
    function fail(error: Error): void {
      if (settled)
        return
      settled = true
      cleanup()
      reject(error)
      child.stdout.resume()
      child.stderr.resume()
      try {
        child.kill()
      }
      catch {}
    }
    function collect(chunk: Buffer): void {
      bytes += chunk.byteLength
      if (bytes > 128 * 1024) {
        fail(new Error('BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。'))
        return
      }
      output += chunk.toString('utf8')
    }
    function close(code: number | null): void {
      if (settled)
        return
      settled = true
      cleanup()
      child.off('error', fail)
      resolveProbe({ code, output })
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', fail)
    child.once('close', close)
  })
}
