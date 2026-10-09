import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isLoopbackPeer, isLoopbackSource } from './source'

const SESSION = 'session-token'

function headers(source?: string, session?: string): IncomingHttpHeaders {
  return {
    ...source === undefined ? {} : { 'x-dsh-remote-source': source },
    ...session === undefined ? {} : { 'x-dsh-remote-session': session },
  }
}

describe('isLoopbackPeer', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts %s as the loopback peer', (address) => {
    expect(isLoopbackPeer(address)).toBe(true)
  })

  it.each(['10.1.2.3', '192.168.1.20', '127.0.0.2', '::ffff:10.1.2.3', undefined, ''])('rejects %s as a non-loopback peer', (address) => {
    expect(isLoopbackPeer(address)).toBe(false)
  })
})

describe('isLoopbackSource', () => {
  /**
   * 「两枚头都不存在 → 回退 TCP 对端」是 S2 §9 明文规定的插件侧判定（主 Spec §5 把该机制的
   * 定义权判给 S2）。它同时是桌面壳经 Tauri 桥直连回环的唯一放行依据，故不能收紧成一律拒绝；
   * 网关反代到本机 DSH 时对端也是回环，S2 注入腿一旦漏注入，本插件看到的正是这一形态，
   * 防线在 S2 侧（先剥离后必注入），不在本函数。
   */
  it('falls back to the peer address when neither internal header is present', () => {
    expect(isLoopbackSource(headers(), '127.0.0.1', SESSION)).toBe(true)
    expect(isLoopbackSource(headers(), '10.1.2.3', SESSION)).toBe(false)
  })

  it('accepts a forwarded request whose matching session declares loopback', () => {
    expect(isLoopbackSource(headers('loopback', SESSION), '127.0.0.1', SESSION)).toBe(true)
  })

  it.each(['private', 'public', 'tunnel', 'loopback '])('rejects the forwarded classification %j', (source) => {
    expect(isLoopbackSource(headers(source, SESSION), '127.0.0.1', SESSION)).toBe(false)
  })

  it('rejects a classified request whose session token does not match', () => {
    expect(isLoopbackSource(headers('loopback', 'forged'), '127.0.0.1', SESSION)).toBe(false)
  })

  it('rejects a classification header without the session header even from a loopback peer', () => {
    expect(isLoopbackSource(headers('loopback'), '127.0.0.1', SESSION)).toBe(false)
    expect(isLoopbackSource(headers(undefined, SESSION), '127.0.0.1', SESSION)).toBe(false)
  })

  it('rejects every classified request while no gateway session is installed', () => {
    expect(isLoopbackSource(headers('loopback', SESSION), '127.0.0.1', '')).toBe(false)
  })

  it('rejects a duplicated multi-value classification header', () => {
    expect(isLoopbackSource({ 'x-dsh-remote-source': ['private', 'loopback'], 'x-dsh-remote-session': SESSION }, '127.0.0.1', SESSION)).toBe(false)
  })

  it.each(['private, loopback', 'private, loopback, tunnel'])('rejects the comma-joined %j that a gateway append produces', (joined) => {
    expect(isLoopbackSource({ 'x-dsh-remote-source': joined, 'x-dsh-remote-session': SESSION }, '127.0.0.1', SESSION)).toBe(false)
    expect(isLoopbackSource({ 'x-dsh-remote-source': joined, 'x-dsh-remote-session': SESSION }, '10.1.2.3', SESSION)).toBe(false)
  })

  it('rejects a joined classification even when loopback is the first value', () => {
    expect(isLoopbackSource({ 'x-dsh-remote-source': 'loopback, private', 'x-dsh-remote-session': SESSION }, '127.0.0.1', SESSION)).toBe(false)
  })

  it('never falls back to the peer address once any internal header is present', () => {
    expect(isLoopbackSource(headers('loopback', 'stale'), '127.0.0.1', SESSION)).toBe(false)
    expect(isLoopbackSource(headers(undefined, 'stale'), '127.0.0.1', SESSION)).toBe(false)
  })
})
