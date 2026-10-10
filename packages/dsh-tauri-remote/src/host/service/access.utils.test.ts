import type { NetworkInterfaceInfo } from 'node:os'
import type { RemoteAccessAddress, RemoteAccessStatus } from './access.types'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPassword } from '../utils/auth'
import { ACCESS_DOCUMENT_VERSION, addressProblemOf, buildLink, DEFAULT_ACCESS_ADDRESS, DEFAULT_ACCESS_PORT, defaultAccessDocument, enumerateAddresses, isReachableAddress, isSelectableAddress, linkHostOf, maskLinkOf, parseAccessDocument, patchAccessDocument, policyOf, rankAddresses, readAccessDocument, redactStatus, serializeAccessDocument, writeAccessDocument } from './access.utils'

const homes: string[] = []

let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-access-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = previousHome
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
})

function accessFile(): string {
  return join(process.env.DSH_HOME ?? '', 'remote', 'access.json')
}

function writeAccessFile(text: string): void {
  mkdirSync(dirname(accessFile()), { recursive: true })
  writeFileSync(accessFile(), text)
}

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` }
}

function v6(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal, cidr: `${address}/64`, scopeid: 0 }
}

function entry(address: string, overrides: Partial<RemoteAccessAddress> = {}): RemoteAccessAddress {
  return {
    address,
    family: address.includes(':') ? 'ipv6' : 'ipv4',
    interface: 'en0',
    scope: 'private',
    score: 120,
    recommended: false,
    ...overrides,
  }
}

function statusFixture(): RemoteAccessStatus {
  return {
    version: ACCESS_DOCUMENT_VERSION,
    enabled: true,
    state: 'listening',
    listening: true,
    listen: { address: '192.168.1.5', port: 3088 },
    port: 3089,
    auth: { enabled: true, scope: 'public_only', hasPassword: true, hasToken: true },
    addresses: [entry('192.168.1.5', { recommended: true })],
    recommended: '192.168.1.5',
    link: 'http://192.168.1.5:3089/?auth=secret-token',
    maskLink: 'http://192.168.1.5:3089/?auth=***',
    qr: 'data:image/png;base64,QUJD',
    tunnel: {
      enabled: true,
      mode: 'quick',
      hostname: 'x.trycloudflare.com',
      token: 'tunnel-secret',
      state: 'running',
      events: [{ seq: 1, ts: '2026-10-05T00:00:00.000Z', kind: 'process', line: 'cloudflared 已启动' }],
      url: 'https://x.trycloudflare.com',
      port: 3089,
      link: 'https://x.trycloudflare.com/?auth=secret-token',
      qr: 'data:image/png;base64,QUJD',
    },
    localPort: 3080,
    error: '示例错误',
    warnings: ['丢弃未知键 foo'],
    events: [{ seq: 1, ts: '2026-10-05T00:00:00.000Z', kind: 'state', line: '入站暴露已监听' }],
  }
}

describe('parseAccessDocument', () => {
  it('文件缺失或全为空白时回落默认文档且不算损坏', () => {
    const missing = parseAccessDocument(undefined)
    expect(missing.document).toEqual(defaultAccessDocument())
    expect(missing.corrupt).toBe(false)
    const blank = parseAccessDocument('  \n')
    expect(blank.document).toEqual(defaultAccessDocument())
    expect(blank.corrupt).toBe(false)
  })

  it('无法解析的 JSON 视为未配置并标记损坏，不抛错', () => {
    const parsed = parseAccessDocument('{ not json')
    expect(parsed.corrupt).toBe(true)
    expect(parsed.document.enabled).toBe(false)
    expect(parsed.warnings[0]).toContain('解析失败')
  })

  it('丢弃未知顶层键并告警，已知键照常生效', () => {
    const parsed = parseAccessDocument(JSON.stringify({ version: 3, enabled: true, listen: { address: '10.0.0.2', port: 4000 }, rogue: 1 }))
    expect(parsed.warnings).toEqual(['access.json 丢弃未知键 rogue'])
    expect(parsed.document.version).toBe(3)
    expect(parsed.document.enabled).toBe(true)
    expect(parsed.document.listen).toEqual({ address: '10.0.0.2', port: 4000 })
  })

  it('丢弃 listen / auth 段里的未知键并告警', () => {
    const parsed = parseAccessDocument(JSON.stringify({ listen: { address: '10.0.0.2', port: 4000, extra: true }, auth: { enabled: true, password: null, token: null, scope: 'all', extra: 1 } }))
    expect(parsed.warnings).toEqual(['access.json 丢弃未知键 listen.extra', 'access.json 丢弃未知键 auth.extra'])
    expect(parsed.document.auth.scope).toBe('all')
  })

  it('非法 scope 回落 public_only 且其余键保留', () => {
    const parsed = parseAccessDocument(JSON.stringify({ enabled: true, auth: { enabled: true, scope: 'lan_only', token: 'keep-me' } }))
    expect(parsed.document.auth.scope).toBe('public_only')
    expect(parsed.document.auth.enabled).toBe(true)
    expect(parsed.document.auth.token).toBe('keep-me')
    expect(parsed.document.enabled).toBe(true)
    expect(parsed.warnings).toEqual(['access.json 的 auth.scope 非法，已回落 public_only'])
  })

  it('缺键时逐键回落默认值', () => {
    const parsed = parseAccessDocument('{}')
    expect(parsed.document.listen.address).toBe(DEFAULT_ACCESS_ADDRESS)
    expect(parsed.document.listen.port).toBe(DEFAULT_ACCESS_PORT)
    expect(parsed.document.auth).toEqual({ enabled: false, password: null, token: null, scope: 'public_only' })
  })

  it('非法 listen.port 与 listen.address 各自回落并告警', () => {
    const parsed = parseAccessDocument(JSON.stringify({ listen: { address: '', port: 70000 } }))
    expect(parsed.document.listen).toEqual({ address: DEFAULT_ACCESS_ADDRESS, port: DEFAULT_ACCESS_PORT })
    expect(parsed.warnings).toEqual(['access.json 的 listen.address 非法，已回落 127.0.0.1', 'access.json 的 listen.port 非法，已回落 3088'])
  })

  it('tunnel 段按契约逐键解析（token 与 hostname 都保留）', () => {
    const tunnel = { enabled: true, mode: 'token', token: 'cf-token', hostname: 'dsh.example.com' }
    const parsed = parseAccessDocument(JSON.stringify({ tunnel }))
    expect(parsed.document.tunnel).toEqual(tunnel)
    expect(parsed.warnings).toEqual([])
  })

  it('tunnel 段的未知键丢弃并告警，非法值逐键回落', () => {
    const parsed = parseAccessDocument(JSON.stringify({ tunnel: { enabled: 'yes', mode: 'named', extra: 1 } }))
    expect(parsed.document.tunnel).toEqual({ enabled: false, mode: 'quick', token: null, hostname: null })
    expect(parsed.warnings).toEqual([
      'access.json 丢弃未知键 tunnel.extra',
      'access.json 的 tunnel.enabled 非法，已回落 false',
      'access.json 的 tunnel.mode 非法，已回落 quick',
    ])
  })

  it('非对象的 tunnel 段回落默认并告警', () => {
    const parsed = parseAccessDocument(JSON.stringify({ tunnel: 'quick' }))
    expect(parsed.document.tunnel).toEqual({ enabled: false, mode: 'quick', token: null, hostname: null })
    expect(parsed.warnings).toEqual(['access.json 的 tunnel 非法，已回落默认'])
  })

  it('形态合法但不可用的密码记录原样保留，供网关判定「认证存储损坏」', () => {
    const password = { algo: 'pbkdf2-sha256', salt: 'not-base64!!', iterations: 600000, hash: 'short' }
    const parsed = parseAccessDocument(JSON.stringify({ auth: { enabled: true, password } }))
    expect(parsed.document.auth.password).toEqual(password)
    expect(parsed.warnings).toEqual([])
  })

  it('形态非法的密码记录丢弃并告警', () => {
    const parsed = parseAccessDocument(JSON.stringify({ auth: { password: { algo: 'sha1', salt: 'x', iterations: 1, hash: 'y' } } }))
    expect(parsed.document.auth.password).toBeNull()
    expect(parsed.warnings).toEqual(['access.json 的 auth.password 非法，已丢弃'])
  })

  it('序列化结果可被原样解析回来', () => {
    const document = { ...defaultAccessDocument(), enabled: true, listen: { address: '10.0.0.2', port: 4000 } }
    expect(serializeAccessDocument(document).endsWith('\n')).toBe(true)
    expect(parseAccessDocument(serializeAccessDocument(document)).document).toEqual(document)
  })
})

describe('readAccessDocument / writeAccessDocument', () => {
  it('落盘为 0600 文件与 0700 目录，且不残留临时文件', () => {
    writeAccessDocument({ ...defaultAccessDocument(), enabled: true })
    expect(statSync(accessFile()).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(accessFile())).mode & 0o777).toBe(0o700)
    expect(readdirSync(dirname(accessFile()))).toEqual(['access.json'])
  })

  it('写入后读回同一份文档', () => {
    const document = { ...defaultAccessDocument(), enabled: true, listen: { address: '192.168.1.5', port: 4100 }, auth: { enabled: true, password: null, token: 'tok', scope: 'all' as const } }
    writeAccessDocument(document)
    expect(readAccessDocument().document).toEqual(document)
  })

  it('解析失败的文件保留在磁盘上供手工修复', () => {
    writeAccessFile('{ broken')
    expect(readAccessDocument().corrupt).toBe(true)
    expect(existsSync(accessFile())).toBe(true)
    expect(readFileSync(accessFile(), 'utf8')).toBe('{ broken')
  })

  it('文件不存在时读回默认文档', () => {
    expect(readAccessDocument().document).toEqual(defaultAccessDocument())
    expect(readAccessDocument().corrupt).toBe(false)
  })
})

describe('enumerateAddresses / rankAddresses', () => {
  it('物理网卡排在虚拟网卡之前，推荐位落在物理私网地址上', () => {
    const addresses = enumerateAddresses({
      docker0: [v4('172.17.0.1')],
      en0: [v4('192.168.1.5')],
    })
    expect(addresses.map(item => item.address)).toEqual(['192.168.1.5', '172.17.0.1'])
    expect(addresses.find(item => item.recommended)?.address).toBe('192.168.1.5')
    expect(addresses.every(item => item.interface !== undefined)).toBe(true)
  })

  it('私网优先于公网、IPv4 优先于 IPv6', () => {
    const addresses = rankAddresses([
      entry('203.0.113.7', { scope: 'public', score: 100 }),
      entry('192.168.1.5', { scope: 'private', score: 120 }),
      entry('fd00::1', { scope: 'private', score: 115, family: 'ipv6' }),
    ])
    expect(addresses.map(item => item.address)).toEqual(['192.168.1.5', 'fd00::1', '203.0.113.7'])
    expect(addresses.map(item => item.recommended)).toEqual([true, false, false])
  })

  it('回环地址不进入枚举结果', () => {
    const addresses = enumerateAddresses({ lo0: [v4('127.0.0.1', true), v6('::1', true)] })
    expect(addresses).toEqual([])
  })

  it('仅剩 link-local 时没有任何推荐地址', () => {
    const addresses = enumerateAddresses({ en0: [v6('fe80::1234%en0'), v4('169.254.10.10')] })
    expect(addresses).toHaveLength(2)
    expect(addresses.some(item => item.recommended)).toBe(false)
    expect(addresses.map(item => item.scope)).toEqual(['link-local', 'link-local'])
  })

  it('评分把网卡名、地址族与私网属性一起计入', () => {
    const addresses = enumerateAddresses({
      utun3: [v6('fd00::9')],
      en0: [v4('203.0.113.7')],
      wlan0: [v4('10.1.2.3')],
    })
    expect(addresses.map(item => item.address)).toEqual(['10.1.2.3', '203.0.113.7', 'fd00::9'])
  })
})

describe('isReachableAddress / linkHostOf / addressProblemOf', () => {
  it('排除回环、link-local、带 zone id 的地址与 0.0.0.0 / ::', () => {
    expect(isReachableAddress('192.168.1.5')).toBe(true)
    expect(isReachableAddress('fd00::1')).toBe(true)
    expect(isReachableAddress('127.0.0.1')).toBe(false)
    expect(isReachableAddress('::1')).toBe(false)
    expect(isReachableAddress('fe80::1')).toBe(false)
    expect(isReachableAddress('febf::1')).toBe(false)
    expect(isReachableAddress('169.254.1.1')).toBe(false)
    expect(isReachableAddress('fd00::1%en0')).toBe(false)
    expect(isReachableAddress('0.0.0.0')).toBe(false)
    expect(isReachableAddress('::')).toBe(false)
  })

  it('通配监听取评分最高的可达地址，绝不产生 0.0.0.0 链接', () => {
    const addresses = rankAddresses([
      entry('0.0.0.0', { score: 0 }),
      entry('10.1.2.3', { score: 125 }),
      entry('169.254.10.10', { score: 0, scope: 'link-local' }),
    ])
    expect(linkHostOf('0.0.0.0', addresses)).toBe('10.1.2.3')
    expect(linkHostOf('::', addresses)).toBe('10.1.2.3')
    expect(addressProblemOf('0.0.0.0', addresses)).toBeUndefined()
  })

  it('具体对外地址用其本身，回环监听用回环地址', () => {
    const addresses = rankAddresses([entry('10.1.2.3'), entry('fd00::1', { family: 'ipv6', score: 115 })])
    expect(linkHostOf('10.1.2.3', addresses)).toBe('10.1.2.3')
    expect(linkHostOf('fd00::1', addresses)).toBe('fd00::1')
    expect(linkHostOf('127.0.0.1', addresses)).toBe('127.0.0.1')
  })

  it('通配监听但没有任何可达地址时判为错误且不生成链接', () => {
    const addresses = rankAddresses([entry('169.254.10.10', { scope: 'link-local', score: 30 })])
    expect(linkHostOf('0.0.0.0', addresses)).toBeUndefined()
    expect(addressProblemOf('0.0.0.0', addresses)).toBe('当前没有任何可用的对外地址，请重新选择网卡')
  })

  it('选定地址消失时给出重新选网卡的提示', () => {
    const addresses = rankAddresses([entry('10.1.2.3')])
    expect(addressProblemOf('10.1.2.4', addresses)).toBe('选定地址 10.1.2.4 已不存在，请重新选择网卡')
    expect(addressProblemOf('10.1.2.3', addresses)).toBeUndefined()
    expect(addressProblemOf('127.0.0.1', addresses)).toBeUndefined()
  })

  it('选定 link-local 地址时判为错误且不生成链接', () => {
    const addresses = rankAddresses([entry('169.254.10.10', { scope: 'link-local', score: 30 })])
    expect(linkHostOf('169.254.10.10', addresses)).toBeUndefined()
    expect(addressProblemOf('169.254.10.10', addresses)).toContain('link-local')
  })
})

describe('buildLink / maskLinkOf', () => {
  it('iPv4 链接带端口与 auth 参数', () => {
    expect(buildLink('192.168.1.5', 3089, 'abc123')).toBe('http://192.168.1.5:3089/?auth=abc123')
  })

  it('iPv6 链接给地址加方括号', () => {
    expect(buildLink('fd00::1', 3089, 'abc123')).toBe('http://[fd00::1]:3089/?auth=abc123')
  })

  it('token 缺失时链接不带 auth 参数', () => {
    expect(buildLink('192.168.1.5', 3089, null)).toBe('http://192.168.1.5:3089/')
  })

  it('掩码链接保留主机与端口、隐藏 Token', () => {
    expect(maskLinkOf('192.168.1.5', 3089, true)).toBe('http://192.168.1.5:3089/?auth=***')
    expect(maskLinkOf('fd00::1', 3089, true)).toBe('http://[fd00::1]:3089/?auth=***')
    expect(maskLinkOf('192.168.1.5', 3089, false)).toBe('http://192.168.1.5:3089/')
  })
})

describe('patchAccessDocument', () => {
  it('password: null 清除已设密码，字符串则写入新哈希', () => {
    const document = { ...defaultAccessDocument(), auth: { enabled: true, password: { algo: 'pbkdf2-sha256' as const, salt: 's', iterations: 1, hash: 'h' }, token: null, scope: 'public_only' as const } }
    expect(patchAccessDocument(document, { password: null }, []).auth.password).toBeNull()
    const written = patchAccessDocument(document, { password: 'next-pass' }, []).auth.password
    expect(written?.algo).toBe('pbkdf2-sha256')
    expect(written?.hash).not.toBe('h')
  })

  it('缺省字段保持原值，password 为只写字段', () => {
    const document = { ...defaultAccessDocument(), enabled: true, auth: { enabled: true, password: null, token: 'keep', scope: 'all' as const } }
    const next = patchAccessDocument(document, { port: 4100 }, [entry('10.1.2.3')])
    expect(next.enabled).toBe(true)
    expect(next.listen).toEqual({ address: DEFAULT_ACCESS_ADDRESS, port: 4100 })
    expect(next.auth).toEqual({ enabled: true, password: null, token: 'keep', scope: 'all' })
  })

  it('提交密码时只存哈希且可被校验通过', () => {
    const next = patchAccessDocument(defaultAccessDocument(), { password: 'hunter2' }, [])
    expect(next.auth.password?.algo).toBe('pbkdf2-sha256')
    expect(next.auth.password?.hash).not.toContain('hunter2')
    expect(verifyPassword('hunter2', next.auth.password)).toBe(true)
    expect(verifyPassword('hunter3', next.auth.password)).toBe(false)
  })

  it('非法端口、作用域与开关类型一律抛错', () => {
    expect(() => patchAccessDocument(defaultAccessDocument(), { port: 0 }, [])).toThrowError('invalid port')
    expect(() => patchAccessDocument(defaultAccessDocument(), { port: 65536 }, [])).toThrowError('invalid port')
    expect(() => patchAccessDocument(defaultAccessDocument(), { scope: 'lan_only' as never }, [])).toThrowError('invalid scope')
    expect(() => patchAccessDocument(defaultAccessDocument(), { enabled: 'yes' as never }, [])).toThrowError('invalid enabled')
    expect(() => patchAccessDocument(defaultAccessDocument(), { password: '' }, [])).toThrowError('invalid password')
  })

  it('地址必须是当前存在的网卡、通配或回环之一', () => {
    const addresses = [entry('10.1.2.3')]
    expect(isSelectableAddress('10.1.2.3', addresses)).toBe(true)
    expect(isSelectableAddress('0.0.0.0', addresses)).toBe(true)
    expect(isSelectableAddress('127.0.0.1', addresses)).toBe(true)
    expect(isSelectableAddress('10.1.2.4', addresses)).toBe(false)
    expect(() => patchAccessDocument(defaultAccessDocument(), { address: '10.1.2.4' }, addresses)).toThrowError('invalid address: 10.1.2.4')
  })
})

describe('redactStatus', () => {
  it('非回环只保留开关、监听、认证开关与 scope、凭据存在性、地址清单与掩码链接', () => {
    const redacted = redactStatus(statusFixture())
    expect(redacted.link).toBeUndefined()
    expect(redacted.qr).toBeUndefined()
    expect(redacted.localPort).toBeUndefined()
    expect(redacted.auth).toEqual({ enabled: true, scope: 'public_only', hasPassword: true, hasToken: true })
    expect(redacted.maskLink).toBe('http://192.168.1.5:3089/?auth=***')
    expect(redacted.listen).toEqual({ address: '192.168.1.5', port: 3088 })
    expect(redacted.port).toBe(3089)
    expect(redacted.state).toBe('listening')
    expect(redacted.addresses).toHaveLength(1)
  })

  it('脱敏结果序列化后不含 Token、二维码与本机明细', () => {
    const text = JSON.stringify(redactStatus(statusFixture()))
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('tunnel-secret')
    expect(text).not.toContain('data:image/png')
    expect(text).not.toContain('localPort')
  })

  it('隧道段脱敏后保留配置与状态，但不含 Token、链接与二维码', () => {
    expect(statusFixture().tunnel?.token).toBe('tunnel-secret')
    const redacted = redactStatus(statusFixture()).tunnel
    expect(redacted).toEqual({
      enabled: true,
      mode: 'quick',
      hostname: 'x.trycloudflare.com',
      state: 'running',
      events: [{ seq: 1, ts: '2026-10-05T00:00:00.000Z', kind: 'process', line: 'cloudflared 已启动' }],
      url: 'https://x.trycloudflare.com',
      port: 3089,
    })
  })
})

describe('policyOf', () => {
  it('把文档映射为网关认证快照', () => {
    const document = { ...defaultAccessDocument(), auth: { enabled: true, password: null, token: 'tok', scope: 'all' as const } }
    expect(policyOf(document, 'secret')).toEqual({ enabled: true, scope: 'all', password: null, linkToken: 'tok', sessionSecret: 'secret' })
  })
})
