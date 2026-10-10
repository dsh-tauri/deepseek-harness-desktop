import { describe, expect, it } from 'vitest'
import { cloudflaredAsset, cloudflaredDownloadUrls, isCloudflaredVersion, parseQuickTunnelUrl, quickTunnelArgs, tokenTunnelArgs } from './cloudflared'

describe('cloudflared 平台表', () => {
  it('覆盖受支持的平台组合', () => {
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ asset: 'cloudflared-darwin-arm64.tgz', executable: 'cloudflared', archive: true })
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({ asset: 'cloudflared-darwin-amd64.tgz', executable: 'cloudflared', archive: true })
    expect(cloudflaredAsset('linux', 'x64')).toEqual({ asset: 'cloudflared-linux-amd64', executable: 'cloudflared', archive: false })
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({ asset: 'cloudflared-linux-arm64', executable: 'cloudflared', archive: false })
    expect(cloudflaredAsset('win32', 'x64')).toEqual({ asset: 'cloudflared-windows-amd64.exe', executable: 'cloudflared.exe', archive: false })
  })

  it('不支持的平台没有资产，调用方据此给出可读错误', () => {
    expect(cloudflaredAsset('linux', 'arm')).toBeUndefined()
    expect(cloudflaredAsset('freebsd', 'x64')).toBeUndefined()
  })
})

describe('下载源与命令行', () => {
  it('官方直连优先，镜像前缀透传原地址', () => {
    const urls = cloudflaredDownloadUrls('cloudflared-linux-amd64')
    expect(urls).toEqual([
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    ])
  })

  it('quick 模式指向本机隧道入口且关闭自动更新', () => {
    expect(quickTunnelArgs('http://127.0.0.1:3089')).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3089'])
  })

  it('具名隧道只传凭据，公开主机名由控制台 ingress 决定', () => {
    expect(tokenTunnelArgs('cf-token')).toEqual(['tunnel', '--no-autoupdate', 'run', '--token', 'cf-token'])
  })
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
