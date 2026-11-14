import { describe, expect, it } from 'vitest'
import { isSocksProxy } from './proxy'

describe('代理地址的 SOCKS 识别', () => {
  it('认得 SOCKS5 与 SOCKS5H，忽略大小写与空白', () => {
    expect(isSocksProxy('socks5://127.0.0.1:1080')).toBe(true)
    expect(isSocksProxy('socks5h://127.0.0.1:1080')).toBe(true)
    expect(isSocksProxy('  SOCKS5H://127.0.0.1:1080 ')).toBe(true)
  })

  it('http 与 https 代理不是 SOCKS', () => {
    expect(isSocksProxy('http://127.0.0.1:7897')).toBe(false)
    expect(isSocksProxy('https://proxy.example:8443')).toBe(false)
    expect(isSocksProxy('')).toBe(false)
  })
})
