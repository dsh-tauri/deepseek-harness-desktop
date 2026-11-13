import { describe, expect, it } from 'vitest'
import { tunnelArgs } from './cloudflared'

const ENTRY = 'http://127.0.0.1:3089'

describe('tunnelArgs', () => {
  it('quick 模式转发本地入口并把协议固定为 http2', () => {
    expect(tunnelArgs(ENTRY)).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', ENTRY])
  })

  it('具名模式只跑 run 子命令，同样固定 http2', () => {
    expect(tunnelArgs()).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'])
  })

  it('两种模式都不留 cloudflared 缺省的 QUIC（UDP 7844）', () => {
    for (const args of [tunnelArgs(ENTRY), tunnelArgs()]) {
      expect(args).toContain('--protocol')
      expect(args[args.indexOf('--protocol') + 1]).toBe('http2')
    }
  })

  it('具名模式不把入口地址写进参数，凭据只走环境变量', () => {
    expect(tunnelArgs().join(' ')).not.toContain('--url')
  })
})
