import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudflaredAsset, cloudflaredDownloadUrls, fetchCloudflaredRelease, isCloudflaredVersion, parseQuickTunnelUrl, quickTunnelArgs, resolveCloudflared, tokenTunnelArgs, tokenTunnelEnv } from './cloudflared'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_binary: string, _args: string[], _options: object, callback: (error: Error) => void) => callback(new Error('ENOENT'))),
  spawn: vi.fn(),
}))

beforeEach(() => {
  vi.stubEnv('CLOUDFLARED_PATH', '')
  vi.stubEnv('CLOUDFLARED_VERSION', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('cloudflared 平台表', () => {
  it('覆盖受支持的平台组合', () => {
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ asset: 'cloudflared-darwin-arm64.tgz', executable: 'cloudflared', archive: true, digest: 'sha256:a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70' })
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({ asset: 'cloudflared-darwin-amd64.tgz', executable: 'cloudflared', archive: true, digest: 'sha256:903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f' })
    expect(cloudflaredAsset('linux', 'x64')).toEqual({ asset: 'cloudflared-linux-amd64', executable: 'cloudflared', archive: false, digest: 'sha256:d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db' })
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({ asset: 'cloudflared-linux-arm64', executable: 'cloudflared', archive: false, digest: 'sha256:e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08' })
    expect(cloudflaredAsset('win32', 'x64')).toEqual({ asset: 'cloudflared-windows-amd64.exe', executable: 'cloudflared.exe', archive: false, digest: 'sha256:86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c' })
  })

  it('不支持的平台没有资产，调用方据此给出可读错误', () => {
    expect(cloudflaredAsset('linux', 'arm')).toBeUndefined()
    expect(cloudflaredAsset('freebsd', 'x64')).toBeUndefined()
  })
})

describe('下载源与命令行', () => {
  it('按已解析的 tag 拼官方直链，镜像前缀透传原地址', () => {
    const urls = cloudflaredDownloadUrls('cloudflared-linux-amd64', '2026.10.0')
    expect(urls).toEqual([
      'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64',
      'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64',
    ])
  })

  it('cLOUDFLARED_VERSION 固定版本时地址与摘要都按该版本取', () => {
    const urls = cloudflaredDownloadUrls('cloudflared-darwin-arm64.tgz', '2026.10.0', '2026.9.0')
    expect(urls[0]).toBe('https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-darwin-arm64.tgz')
  })

  it('官方发布元数据缺失 sha256 摘要时拒绝执行', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: 'cloudflared-linux-amd64', size: 1 }] }), { status: 200 })) as typeof fetch
    try {
      await expect(fetchCloudflaredRelease('cloudflared-linux-amd64')).rejects.toThrow('sha256')
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('官方发布元数据解析出 tag 与摘要', async () => {
    const original = globalThis.fetch
    const digest = `sha256:${'a'.repeat(64)}`
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: 'cloudflared-linux-amd64', digest, size: 42 }] }), { status: 200 })) as typeof fetch
    try {
      await expect(fetchCloudflaredRelease('cloudflared-linux-amd64')).resolves.toEqual({ tag: '2026.10.0', digest, size: 42 })
    }
    finally {
      globalThis.fetch = original
    }
  })

  it.each([
    [403, undefined],
    [429, ''],
    [403, '2026.10.0'],
  ])('官方发布 API 返回 %i（版本 %s）时使用固定版本的官方摘要', async (status, version) => {
    const fetcher = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchCloudflaredRelease('cloudflared-linux-amd64', version)).resolves.toEqual({
      tag: '2026.10.0',
      digest: 'sha256:d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [403, 'cloudflared-linux-amd64', '2026.9.0'],
    [403, 'cloudflared-freebsd-amd64', undefined],
    [404, 'cloudflared-linux-amd64', undefined],
    [500, 'cloudflared-linux-amd64', undefined],
  ])('元数据 HTTP %i（资产 %s，版本 %s）没有可信兜底时保留错误', async (status, asset, version) => {
    vi.stubGlobal('fetch', async () => new Response(null, { status }))
    await expect(fetchCloudflaredRelease(asset, version)).rejects.toThrow(`发布元数据不可用（HTTP ${status}）`)
  })

  it('quick 模式指向本机隧道入口且关闭自动更新', () => {
    expect(quickTunnelArgs('http://127.0.0.1:3089')).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3089'])
  })

  it('具名隧道的凭据走环境变量，不出现在进程参数里', () => {
    expect(tokenTunnelArgs()).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(tokenTunnelEnv('cf-token')).toEqual({ TUNNEL_TOKEN: 'cf-token' })
    expect(tokenTunnelArgs().join(' ')).not.toContain('cf-token')
  })
})

describe('下载校验', () => {
  it('发布 API 403 时仍尝试固定 tag 下载，但拒绝写出摘要不匹配的文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cloudflared-rate-limit-'))
    const executable = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const names: Record<string, string> = {
      'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
      'darwin-x64': 'cloudflared-darwin-amd64.tgz',
      'linux-x64': 'cloudflared-linux-amd64',
      'linux-arm64': 'cloudflared-linux-arm64',
      'win32-x64': 'cloudflared-windows-amd64.exe',
    }
    const url = `https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/${names[`${process.platform}-${process.arch}`]}`
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('api.github.com')
      ? new Response(null, { status: 403 })
      : new Response(Buffer.from('junk'), { headers: { 'content-length': '4' } }))
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', fetcher)
    try {
      await expect(resolveCloudflared()).rejects.toThrow('SHA-256 校验失败')
      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
        url,
        `https://ghfast.top/${url}`,
      ])
      expect(existsSync(join(home, 'remote', 'bin', executable))).toBe(false)
      expect(vi.mocked(execFile).mock.calls.map(([binary]) => binary)).toEqual(['cloudflared'])
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('摘要不匹配时拒绝执行，且不写出可执行文件', async () => {
    const originalFetch = globalThis.fetch
    const home = mkdtempSync(join(tmpdir(), 'dsh-cloudflared-verify-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.github.com'))
        return new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: cloudflaredAsset()?.asset, digest: `sha256:${'f'.repeat(64)}`, size: 4 }] }), { status: 200 })
      return new Response(Buffer.from('junk'), { status: 200, headers: { 'content-length': '4' } })
    }) as typeof fetch
    try {
      await expect(resolveCloudflared()).rejects.toThrow('SHA-256 校验失败')
      expect(existsSync(join(home, 'remote', 'bin', cloudflaredAsset()?.executable ?? ''))).toBe(false)
    }
    finally {
      globalThis.fetch = originalFetch
      if (previousHome === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('日志解析', () => {
  it('从 cloudflared 的日志行里取出 quick 隧道域名', () => {
    expect(parseQuickTunnelUrl('INF Your quick Tunnel has been created! Visit it at https://bold-fox-abc.trycloudflare.com'))
      .toBe('https://bold-fox-abc.trycloudflare.com')
    expect(parseQuickTunnelUrl('INF |  https://plain-host.trycloudflare.com  |')).toBe('https://plain-host.trycloudflare.com')
  })

  it('不把其它地址当隧道域名', () => {
    expect(parseQuickTunnelUrl('INF Cannot reach https://api.cloudflare.com/client/v4')).toBeUndefined()
    expect(parseQuickTunnelUrl('INF http://bold-fox-abc.trycloudflare.com')).toBeUndefined()
    expect(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
  })

  it('只认 cloudflared 的版本行', () => {
    expect(isCloudflaredVersion('cloudflared version 2026.1.0 (built 2026-01-02-1200)')).toBe(true)
    expect(isCloudflaredVersion('cloudflared version 2026.1.0')).toBe(true)
    expect(isCloudflaredVersion('command not found: cloudflared')).toBe(false)
    expect(isCloudflaredVersion('cloudflared version unknown')).toBe(false)
  })
})
