import type { IncomingHttpHeaders } from 'node:http'
import type { RemoteAccessDecision, RemoteAuthPolicy, RemotePasswordRecord, RemoteSourceClass } from '../types/index'
import { describe, expect, it } from 'vitest'
import { classifyPeer, classifySource, decideSourceAccess, isAuthConfigured, isAuthStorageBroken, isIpAddress, isLoopbackPeer, isLoopbackSource, rateLimitKeyOf } from './source'

const SESSION = 'session-token'

const PASSWORD: RemotePasswordRecord = { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 1, hash: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }

const CORRUPT_PASSWORD: RemotePasswordRecord = { ...PASSWORD, hash: 'aGFzaA==' }

const NO_AUTH: undefined = undefined

const PUBLIC_ONLY: RemoteAuthPolicy = { enabled: true, scope: 'public_only', password: PASSWORD, linkToken: null, sessionSecret: SESSION }

const ALL_SOURCES: RemoteAuthPolicy = { ...PUBLIC_ONLY, scope: 'all' }

function headers(source?: string | string[], session?: string | string[]): IncomingHttpHeaders {
  return {
    ...source === undefined ? {} : { 'x-dsh-remote-source': source },
    ...session === undefined ? {} : { 'x-dsh-remote-session': session },
  }
}

describe('classifyPeer', () => {
  it.each(['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9'])('classifies %s as loopback', (address) => {
    expect(classifyPeer(address)).toBe('loopback')
  })

  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.3.4',
    '100.64.0.1',
    '100.127.255.254',
    '::ffff:192.168.1.5',
    'fe80::1',
    'fe80::1%en0',
    'fc00::1',
    'fd12:3456::1',
  ])('classifies %s as private', (address) => {
    expect(classifyPeer(address)).toBe('private')
  })

  it.each([
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.1.1',
    '169.255.1.1',
    '100.63.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::',
    'not-an-ip',
    '10.1.2',
    '10.1.2.999',
    '',
    undefined,
  ])('classifies %s as public', (address) => {
    expect(classifyPeer(address)).toBe('public')
  })
})

describe('isLoopbackPeer', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])('accepts %s as the loopback peer', (address) => {
    expect(isLoopbackPeer(address)).toBe(true)
  })

  it.each(['10.1.2.3', '192.168.1.20', '::ffff:10.1.2.3', undefined, ''])('rejects %s as a non-loopback peer', (address) => {
    expect(isLoopbackPeer(address)).toBe(false)
  })
})

describe('isIpAddress', () => {
  it.each(['127.0.0.1', '192.168.1.5', '203.0.113.9', '::1', 'fd00::1'])('accepts the address literal %s', (address) => {
    expect(isIpAddress(address)).toBe(true)
  })

  it.each(['', 'localhost', '1.2.3', '999.1.1.1', '1.2.3.4.5', undefined])('rejects the non-address %s', (address) => {
    expect(isIpAddress(address)).toBe(false)
  })
})

describe('classifySource', () => {
  /**
   * 「两枚头都不存在 → 回退 TCP 对端」是 S2 §9 明文规定的插件侧判定（主 Spec §5 把该机制的
   * 定义权判给 S2）。它同时是桌面壳经 Tauri 桥直连回环的唯一放行依据，故不能收紧成一律拒绝；
   * 网关反代到本机 DSH 时对端也是回环，S2 注入腿一旦漏注入，本插件看到的正是这一形态，
   * 防线在 S2 侧（先剥离后必注入），不在本函数。
   */
  it('falls back to the peer address when neither internal header is present', () => {
    expect(classifySource(headers(), '127.0.0.1', SESSION)).toBe('loopback')
    expect(classifySource(headers(), '10.1.2.3', SESSION)).toBe('private')
    expect(classifySource(headers(), '8.8.8.8', SESSION)).toBe('public')
  })

  it('adopts the declared classification of a forwarded request whose session matches', () => {
    expect(classifySource(headers('loopback', SESSION), '10.1.2.3', SESSION)).toBe('loopback')
    expect(classifySource(headers('private', SESSION), '127.0.0.1', SESSION)).toBe('private')
    expect(classifySource(headers('public', SESSION), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers('tunnel', SESSION), '127.0.0.1', SESSION)).toBe('tunnel')
  })

  it('rejects a classified request whose session token does not match', () => {
    expect(classifySource(headers('loopback', 'forged'), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers('tunnel', 'forged'), '127.0.0.1', SESSION)).toBe('public')
  })

  it('rejects a classification header without the session header even from a loopback peer', () => {
    expect(classifySource(headers('loopback'), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers(undefined, SESSION), '127.0.0.1', SESSION)).toBe('public')
  })

  it('rejects every classified request while no gateway session is installed', () => {
    expect(classifySource(headers('loopback', SESSION), '127.0.0.1', '')).toBe('public')
  })

  it('rejects a duplicated multi-value classification header', () => {
    expect(classifySource(headers(['private', 'loopback'], SESSION), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers('loopback', [SESSION, SESSION]), '127.0.0.1', SESSION)).toBe('public')
  })

  it.each(['private, loopback', 'private, loopback, tunnel'])('rejects the comma-joined %j that a gateway append produces', (joined) => {
    expect(classifySource(headers(joined, SESSION), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers(joined, SESSION), '10.1.2.3', SESSION)).toBe('public')
  })

  it.each(['loopback ', 'LOOPBACK', 'lan', ''])('rejects the unknown classification %j instead of trusting it', (declared) => {
    expect(classifySource(headers(declared, SESSION), '127.0.0.1', SESSION)).toBe('public')
  })

  it('never falls back to the peer address once any internal header is present', () => {
    expect(classifySource(headers('loopback', 'stale'), '127.0.0.1', SESSION)).toBe('public')
    expect(classifySource(headers(undefined, 'stale'), '127.0.0.1', SESSION)).toBe('public')
  })

  it('ignores the spoofable forwarding headers entirely', () => {
    const spoofed: IncomingHttpHeaders = { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' }
    expect(classifySource(spoofed, '203.0.113.9', SESSION)).toBe('public')
    expect(classifySource(spoofed, '10.0.0.9', SESSION)).toBe('private')
  })
})

describe('isLoopbackSource', () => {
  it('is exactly the loopback classification, forwarded or direct', () => {
    expect(isLoopbackSource(headers(), '127.0.0.1', SESSION)).toBe(true)
    expect(isLoopbackSource(headers('loopback', SESSION), '10.1.2.3', SESSION)).toBe(true)
    expect(isLoopbackSource(headers('tunnel', SESSION), '127.0.0.1', SESSION)).toBe(false)
    expect(isLoopbackSource(headers(), '10.1.2.3', SESSION)).toBe(false)
  })
})

describe('isAuthConfigured', () => {
  it('requires the switch plus at least one credential', () => {
    expect(isAuthConfigured(NO_AUTH)).toBe(false)
    expect(isAuthConfigured({ ...PUBLIC_ONLY, enabled: false })).toBe(false)
    expect(isAuthConfigured({ ...PUBLIC_ONLY, password: null, linkToken: null })).toBe(false)
    expect(isAuthConfigured({ ...PUBLIC_ONLY, password: null, linkToken: '' })).toBe(false)
    expect(isAuthConfigured(PUBLIC_ONLY)).toBe(true)
    expect(isAuthConfigured({ ...PUBLIC_ONLY, password: null, linkToken: 'token' })).toBe(true)
  })

  it('treats a corrupted password record without a link token as unconfigured', () => {
    expect(isAuthConfigured({ ...PUBLIC_ONLY, password: CORRUPT_PASSWORD })).toBe(false)
    expect(isAuthConfigured({ ...PUBLIC_ONLY, password: CORRUPT_PASSWORD, linkToken: 'token' })).toBe(true)
  })
})

describe('isAuthStorageBroken', () => {
  it('reports corruption only while no usable credential remains', () => {
    expect(isAuthStorageBroken(NO_AUTH)).toBe(false)
    expect(isAuthStorageBroken(PUBLIC_ONLY)).toBe(false)
    expect(isAuthStorageBroken({ ...PUBLIC_ONLY, password: null, linkToken: null })).toBe(false)
    expect(isAuthStorageBroken({ ...PUBLIC_ONLY, password: CORRUPT_PASSWORD })).toBe(true)
    expect(isAuthStorageBroken({ ...PUBLIC_ONLY, password: CORRUPT_PASSWORD, linkToken: 'token' })).toBe(false)
    expect(isAuthStorageBroken({ ...PUBLIC_ONLY, password: CORRUPT_PASSWORD, enabled: false })).toBe(false)
  })
})

describe('decideSourceAccess', () => {
  const SOURCES: RemoteSourceClass[] = ['loopback', 'private', 'public', 'tunnel']

  const CASES: ReadonlyArray<{ source: RemoteSourceClass, unconfigured: RemoteAccessDecision, publicOnly: RemoteAccessDecision, all: RemoteAccessDecision }> = [
    { source: 'loopback', unconfigured: 'allow', publicOnly: 'allow', all: 'allow' },
    { source: 'private', unconfigured: 'allow', publicOnly: 'allow', all: 'authenticate' },
    { source: 'public', unconfigured: 'deny', publicOnly: 'authenticate', all: 'authenticate' },
    { source: 'tunnel', unconfigured: 'deny', publicOnly: 'authenticate', all: 'authenticate' },
  ]

  it('covers every source of the four-by-three matrix', () => {
    expect(CASES.map(entry => entry.source)).toEqual(SOURCES)
  })

  for (const entry of CASES) {
    it(`【矩阵】${entry.source} × 未配置认证 判定为 ${entry.unconfigured}`, () => {
      expect(decideSourceAccess(entry.source, NO_AUTH)).toBe(entry.unconfigured)
    })

    it(`【矩阵】${entry.source} × scope=public_only 判定为 ${entry.publicOnly}`, () => {
      expect(decideSourceAccess(entry.source, PUBLIC_ONLY)).toBe(entry.publicOnly)
    })

    it(`【矩阵】${entry.source} × scope=all 判定为 ${entry.all}`, () => {
      expect(decideSourceAccess(entry.source, ALL_SOURCES)).toBe(entry.all)
    })
  }

  it('treats an enabled switch without any credential as unconfigured', () => {
    const halfOpen: RemoteAuthPolicy = { ...PUBLIC_ONLY, password: null, linkToken: null }
    expect(decideSourceAccess('public', halfOpen)).toBe('deny')
    expect(decideSourceAccess('private', halfOpen)).toBe('allow')
  })

  it('treats a corrupted password record without a link token as unconfigured', () => {
    const corrupted: RemoteAuthPolicy = { ...PUBLIC_ONLY, password: CORRUPT_PASSWORD }
    expect(decideSourceAccess('public', corrupted)).toBe('deny')
    expect(decideSourceAccess('tunnel', corrupted)).toBe('deny')
    expect(decideSourceAccess('private', corrupted)).toBe('allow')
    expect(decideSourceAccess('loopback', corrupted)).toBe('allow')
  })

  it('keeps the physical loopback source free of authentication in every configuration', () => {
    expect(decideSourceAccess('loopback', ALL_SOURCES)).toBe('allow')
    expect(decideSourceAccess('loopback', { ...ALL_SOURCES, password: null, linkToken: null })).toBe('allow')
  })
})

describe('rateLimitKeyOf', () => {
  it('uses the tunnel-declared client address for tunnel sources only', () => {
    expect(rateLimitKeyOf('tunnel', '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitKeyOf('tunnel', '127.0.0.1', '2001:db8::7')).toBe('2001:db8::7')
  })

  it('ignores the declared address for every other source', () => {
    expect(rateLimitKeyOf('private', '192.168.1.5', '203.0.113.7')).toBe('192.168.1.5')
    expect(rateLimitKeyOf('public', '198.51.100.9', '203.0.113.7')).toBe('198.51.100.9')
    expect(rateLimitKeyOf('loopback', '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1')
  })

  it('falls back to the peer address when the declared address is missing or malformed', () => {
    expect(rateLimitKeyOf('tunnel', '127.0.0.1', undefined)).toBe('127.0.0.1')
    expect(rateLimitKeyOf('tunnel', '127.0.0.1', 'not-an-ip')).toBe('127.0.0.1')
    expect(rateLimitKeyOf('tunnel', undefined, undefined)).toBe('unknown')
  })
})
