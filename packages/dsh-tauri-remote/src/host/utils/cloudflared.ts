import type { TunnelHandlers, TunnelProcess } from '../service/tunnel.types'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { promisify } from 'node:util'
import { dirname, join } from 'pathe'
import { messageOf } from '../../shared/error'
import { harnessHome } from '../config/runtime'

const execFileAsync = promisify(execFile)

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/download/'

const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'

const RELEASE_TIMEOUT_MS = 20_000

// ponytail: API 限流时固定已核验版本，升级时同步官方资产摘要。
const FALLBACK_VERSION = '2026.10.0'

const MIRROR_PREFIX = 'https://ghfast.top/'

const STATE_DIR = 'remote'
const BIN_DIR = 'bin'

const DOWNLOAD_TIMEOUT_MS = 120_000
const VERSION_TIMEOUT_MS = 5_000
const EXTRACT_TIMEOUT_MS = 60_000

const RE_VERSION = /^cloudflared version \d+\.\d+\.\d+/m
const RE_QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/

/** 二进制准备阶段的进度：面板据此显示「下载中 x%」而不是静默等待。 */
export interface CloudflaredProgress {
  stage: 'check' | 'download' | 'extract' | 'verify'
  url?: string
  received?: number
  total?: number
}

export type CloudflaredProgressSink = (progress: CloudflaredProgress) => void

export interface CloudflaredAsset {
  asset: string
  executable: string
  archive: boolean
  digest: string
}

const ASSETS: Record<string, CloudflaredAsset> = {
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', executable: 'cloudflared', archive: true, digest: 'sha256:a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70' },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', executable: 'cloudflared', archive: true, digest: 'sha256:903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f' },
  'linux-x64': { asset: 'cloudflared-linux-amd64', executable: 'cloudflared', archive: false, digest: 'sha256:d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', executable: 'cloudflared', archive: false, digest: 'sha256:e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08' },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', executable: 'cloudflared.exe', archive: false, digest: 'sha256:86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c' },
}

export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch): CloudflaredAsset | undefined {
  return ASSETS[`${platform}-${arch}`]
}

/** 候选下载地址：官方 tag 直链优先，镜像只做传输兜底；两者都用同一份官方摘要校验。 */
export function cloudflaredDownloadUrls(asset: string, tag: string, version?: string): string[] {
  const resolved = version === undefined || version === '' ? tag : version
  const primary = `${RELEASE_BASE}${resolved}/${asset}`
  return [primary, `${MIRROR_PREFIX}${primary}`]
}

/** 官方发布的资产摘要：`sha256:` 前缀来自 GitHub Release API，与资产一一对应。 */
export interface CloudflaredRelease {
  tag: string
  digest: string
  size?: number
}

export async function fetchCloudflaredRelease(asset: string, version?: string): Promise<CloudflaredRelease> {
  const url = version === undefined || version === '' ? RELEASE_API : `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}`
  const response = await fetch(url, { signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS), headers: { accept: 'application/vnd.github+json' } })
  if (!response.ok) {
    const fallback = Object.values(ASSETS).find(entry => entry.asset === asset)
    if ((response.status === 403 || response.status === 429) && (version === undefined || version === '' || version === FALLBACK_VERSION) && fallback !== undefined)
      return { tag: FALLBACK_VERSION, digest: fallback.digest }
    throw new Error(`发布元数据不可用（HTTP ${response.status}）`)
  }
  const body = await response.json() as { tag_name?: unknown, assets?: unknown }
  const tag = typeof body.tag_name === 'string' ? body.tag_name : ''
  const entries = Array.isArray(body.assets) ? body.assets : []
  const found = entries.find((entry): entry is { digest?: unknown, size?: unknown } => typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === asset)
  const digest = typeof found?.digest === 'string' ? found.digest : ''
  if (tag === '' || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error(`官方未提供 ${asset} 的 sha256 摘要，拒绝执行未校验的二进制`)
  return { tag, digest, ...typeof found?.size === 'number' ? { size: found.size } : {} }
}

export function quickTunnelArgs(entryUrl: string): string[] {
  return ['tunnel', '--no-autoupdate', '--url', entryUrl]
}

/** 具名隧道：凭据经 `TUNNEL_TOKEN` 环境变量传入，避免出现在进程参数（`ps` 可见）里。 */
export function tokenTunnelArgs(): string[] {
  return ['tunnel', '--no-autoupdate', 'run']
}

export function tokenTunnelEnv(token: string): NodeJS.ProcessEnv {
  return { TUNNEL_TOKEN: token }
}

export function parseQuickTunnelUrl(line: string): string | undefined {
  return RE_QUICK_URL.exec(line)?.[0]
}

export function isCloudflaredVersion(output: string): boolean {
  return RE_VERSION.test(output)
}

/** PATH 优先、数据目录次之、最后按平台下载；失败原因一律可读（含尝试过的地址）。 */
export async function resolveCloudflared(onProgress?: CloudflaredProgressSink): Promise<string> {
  onProgress?.({ stage: 'check' })
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
  return await downloadCloudflared(target, onProgress)
}

export function spawnCloudflared(binary: string, args: string[], handlers: TunnelHandlers, env?: NodeJS.ProcessEnv): TunnelProcess {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...env === undefined ? {} : { env: { ...process.env, ...env } } })
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

async function downloadCloudflared(target: string, onProgress?: CloudflaredProgressSink): Promise<string> {
  const asset = cloudflaredAsset()
  if (asset === undefined)
    throw new Error(`不支持的平台：${process.platform}-${process.arch}；请自行安装 cloudflared 并设置 CLOUDFLARED_PATH`)
  const release = await fetchCloudflaredRelease(asset.asset, process.env.CLOUDFLARED_VERSION)
  const expected = release.digest.slice('sha256:'.length)
  const failures: string[] = []
  for (const url of cloudflaredDownloadUrls(asset.asset, release.tag, process.env.CLOUDFLARED_VERSION)) {
    try {
      onProgress?.({ stage: 'download', url, received: 0, ...release.size === undefined ? {} : { total: release.size } })
      await downloadInto(url, asset, target, expected, onProgress)
      onProgress?.({ stage: 'verify' })
      if (!await runsCloudflared(target))
        throw new Error('下载完成但 --version 自检失败')
      return target
    }
    catch (error) {
      failures.push(`${url} → ${messageOf(error)}`)
    }
  }
  throw new Error(`cloudflared 下载失败（已尝试：${failures.join('；')}；官方摘要 ${release.digest}）；可手工安装后放到 ${target} 或设置 CLOUDFLARED_PATH`)
}

async function downloadInto(url: string, asset: CloudflaredAsset, target: string, expectedSha256: string, onProgress?: CloudflaredProgressSink): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
  const chunks: Buffer[] = []
  let received = 0
  if (response.body === null) {
    const body = Buffer.from(await response.arrayBuffer())
    chunks.push(body)
    received = body.length
  }
  else {
    const reader = response.body.getReader()
    while (true) {
      const step = await reader.read()
      if (step.done)
        break
      const chunk = Buffer.from(step.value)
      chunks.push(chunk)
      received += chunk.length
      onProgress?.({ stage: 'download', url, received, ...total === undefined ? {} : { total } })
    }
  }
  const body = Buffer.concat(chunks)
  if (body.length === 0)
    throw new Error('响应为空')
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== expectedSha256)
    throw new Error(`SHA-256 校验失败（期望 ${expectedSha256}，实际 ${actual}），已丢弃该文件`)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!asset.archive) {
    writeFileSync(target, body)
    chmodSync(target, 0o755)
    return
  }
  onProgress?.({ stage: 'extract', url })
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
