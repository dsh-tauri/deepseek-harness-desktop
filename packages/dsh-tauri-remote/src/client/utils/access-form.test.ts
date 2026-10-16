import type { AccessTunnel } from '../types/index'
import { describe, expect, it } from 'vitest'
import {
  countdownOf,
  lanDirtyOf,
  maskAuthOf,
  tunnelBodyOf,
  tunnelDirtyOf,
  tunnelDraftOf,
  tunnelMissingOf,
} from './access-form'

const stopped: AccessTunnel = { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] }

describe('接入面板草稿与格式化', () => {
  it('倒计时按 分:秒 渲染，过期与不足一秒都为空串', () => {
    expect(countdownOf(1_000_000 + 300_000, 1_000_000)).toBe('5:00')
    expect(countdownOf(1_000_000 + 65_000, 1_000_000)).toBe('1:05')
    expect(countdownOf(1_000_000 + 400, 1_000_000)).toBe('')
    expect(countdownOf(1_000_000, 1_000_000)).toBe('')
  })

  it('局域网草稿只在地址真的变了才算脏', () => {
    expect(lanDirtyOf(null, { address: '192.168.1.5' })).toBe(false)
    expect(lanDirtyOf({ address: '192.168.1.5' }, { address: '192.168.1.5' })).toBe(false)
    expect(lanDirtyOf({ address: '127.0.0.1' }, { address: '192.168.1.5' })).toBe(true)
  })

  it('隧道草稿以已保存配置为基线，改回原值即不脏', () => {
    const saved: AccessTunnel = { ...stopped, enabled: true, mode: 'token', token: 'cf', hostname: 'dsh.example.com' }
    expect(tunnelDraftOf(saved)).toEqual({ mode: 'token', token: 'cf', hostname: 'dsh.example.com' })
    expect(tunnelDraftOf(stopped)).toEqual({ mode: 'quick', token: null, hostname: '' })
    expect(tunnelDirtyOf(null, saved)).toBe(false)
    expect(tunnelDirtyOf(tunnelDraftOf(saved), saved)).toBe(false)
    const edited = { ...tunnelDraftOf(saved), hostname: 'other.example.com' }
    expect(tunnelDirtyOf(edited, saved)).toBe(true)
    expect(tunnelDirtyOf({ ...tunnelDraftOf(saved), mode: 'quick' as const }, saved)).toBe(true)
  })

  it('具名模式缺必填项时指出缺哪一个，quick 模式不校验', () => {
    expect(tunnelMissingOf({ mode: 'quick', token: null, hostname: '' })).toBeUndefined()
    expect(tunnelMissingOf({ mode: 'token', token: null, hostname: 'dsh.example.com' })).toBe('token')
    expect(tunnelMissingOf({ mode: 'token', token: '  ', hostname: 'dsh.example.com' })).toBe('token')
    expect(tunnelMissingOf({ mode: 'token', token: 'cf', hostname: ' ' })).toBe('hostname')
    expect(tunnelMissingOf({ mode: 'token', token: 'cf', hostname: 'dsh.example.com' })).toBeUndefined()
  })

  it('提交体从不提交空 Token 或空主机名，但会带出已保存的 Token', () => {
    expect(tunnelBodyOf({ mode: 'quick', token: null, hostname: '' })).toEqual({ mode: 'quick' })
    expect(tunnelBodyOf({ mode: 'token', token: 'cf', hostname: 'dsh.example.com' })).toEqual({
      mode: 'token',
      token: 'cf',
      hostname: 'dsh.example.com',
    })
    expect(tunnelBodyOf({ mode: 'token', token: 'cf', hostname: '' })).toEqual({ mode: 'token', token: 'cf' })
  })

  it('永久码掩码只抹掉 auth 参数', () => {
    expect(maskAuthOf('http://192.168.1.5:3088/?auth=tok')).toBe('http://192.168.1.5:3088/?auth=••••••')
    expect(maskAuthOf('https://x.trycloudflare.com/?auth=tok&b=1')).toBe('https://x.trycloudflare.com/?auth=••••••&b=1')
    expect(maskAuthOf('http://192.168.1.5:3088/')).toBe('http://192.168.1.5:3088/')
  })
})
