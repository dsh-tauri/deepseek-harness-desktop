import type { TunnelHandlers, TunnelProcess } from '../service/tunnel.types'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { promisify } from 'node:util'
import { dirname, join } from 'pathe'
import { messageOf } from '../../shared/error'
import { harnessHome } from '../config/runtime'

const execFileAsync = promisify(execFile)

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

const MIRROR_PREFIX = 'https://ghfast.top/'

const STATE_DIR = 'remote'
const BIN_DIR = 'bin'

const DOWNLOAD_TIMEOUT_MS = 120_000
const VERSION_TIMEOUT_MS = 5_000
const EXTRACT_TIMEOUT_MS = 60_000

const RE_VERSION = /^cloudflared version \d+\.\d+\.\d+/m
const RE_QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/

export interface CloudflaredAsset {
  asset: string
  executable: string
  archive: boolean
}

const ASSETS: Record<string, CloudflaredAsset> = {
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', executable: 'cloudflared', archive: true },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', executable: 'cloudflared', archive: true },
  'linux-x64': { asset: 'cloudflared-linux-amd64', executable: 'cloudflared', archive: false },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', executable: 'cloudflared', archive: false },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', executable: 'cloudflared.exe', archive: false },
}

export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch): CloudflaredAsset | undefined {
  return ASSETS[`${platform}-${arch}`]
}

export function cloudflaredDownloadUrls(asset: string): string[] {
  const primary = `${RELEASE_BASE}${asset}`
  return [primary, `${MIRROR_PREFIX}${primary}`]
}

export function quickTunnelArgs(entryUrl: string): string[] {
  return ['tunnel', '--no-autoupdate', '--url', entryUrl]
}

export function tokenTunnelArgs(token: string): string[] {
  return ['tunnel', '--no-autoupdate', 'run', '--token', token]
}

export function parseQuickTunnelUrl(line: string): string | undefined {
  return RE_QUICK_URL.exec(line)?.[0]
}

export function isCloudflaredVersion(output: string): boolean {
  return RE_VERSION.test(output)
}

/** PATH 优先、数据目录次之、最后按平台下载；失败原因一律可读（含尝试过的地址）。 */
export async function resolveCloudflared(): Promise<string> {
  const override = process.env.CLOUDFLARED_PATH
  if (override !== undefined && override.trim() !== '') {
    if (await runsCloudflared(override.trim()))
      return override.trim()
    throw new Error(`CLOUDFLARED_PATH 指向的可执行文件不可用：${override.trim()}`)
  }
  if (await runsCloudflared('cloudflared'))
    return 'cloudflared'
  const target = installedBinaryPath()
  if (existsSync(target) && await runsCloudflared(target))
    return target
  return await downloadCloudflared(target)
}

export function spawnCloudflared(binary: string, args: string[], handlers: TunnelHandlers): TunnelProcess {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      handlers.onExit(code, signal)
      resolve()
    })
  })
  consumeLines(child.stdout, handlers.onLine)
  consumeLines(child.stderr, handlers.onLine)
  return {
    pid: child.pid,
    exited,
    kill: (signal) => {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        return
      }
      child.kill(signal)
    },
  }
}

// --- internal ---
function installedBinaryPath(): string {
  const asset = cloudflaredAsset()
  if (asset === undefined)
    throw new Error(`不支持的平台：${process.platform}-${process.arch}；请自行安装 cloudflared 并设置 CLOUDFLARED_PATH`)
  return join(harnessHome(), STATE_DIR, BIN_DIR, asset.executable)
}

async function runsCloudflared(binary: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS })
    return isCloudflaredVersion(`${stdout}\n${stderr}`)
  }
  catch {
    return false
  }
}

async function downloadCloudflared(target: string): Promise<string> {
  const asset = cloudflaredAsset()
  if (asset === undefined)
    throw new Error(`不支持的平台：${process.platform}-${process.arch}；请自行安装 cloudflared 并设置 CLOUDFLARED_PATH`)
  const failures: string[] = []
  for (const url of cloudflaredDownloadUrls(asset.asset)) {
    try {
      await downloadInto(url, asset, target)
      if (!await runsCloudflared(target))
        throw new Error('下载完成但 --version 自检失败')
      return target
    }
    catch (error) {
      failures.push(`${url} → ${messageOf(error)}`)
    }
  }
  throw new Error(`cloudflared 下载失败（已尝试：${failures.join('；')}）；可手工安装后放到 ${target} 或设置 CLOUDFLARED_PATH`)
}

async function downloadInto(url: string, asset: CloudflaredAsset, target: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length === 0)
    throw new Error('响应为空')
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!asset.archive) {
    writeFileSync(target, body)
    chmodSync(target, 0o755)
    return
  }
  const staging = mkdtempSync(join(tmpdir(), 'dsh-cloudflared-'))
  try {
    const archive = join(staging, asset.asset)
    writeFileSync(archive, body)
    await execFileAsync('tar', ['-xzf', archive, '-C', staging, asset.executable], { timeout: EXTRACT_TIMEOUT_MS })
    const extracted = join(staging, asset.executable)
    if (!existsSync(extracted))
      throw new Error(`压缩包内没有 ${asset.executable}`)
    writeFileSync(target, readFileSync(extracted))
    chmodSync(target, 0o755)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function consumeLines(stream: NodeJS.ReadableStream | null, listener: (line: string) => void): void {
  if (stream === null)
    return
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines)
      listener(line)
  })
}
