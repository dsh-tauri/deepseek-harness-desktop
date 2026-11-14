import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildConnectUrl, connectionLabel, isBridgeManifest, isRecord, isRemoteHost, isTrustedOrigin, parseAddressInput, parseQrPayload, rebuildAddress } from './bridge-protocol'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('parseQrPayload', () => {
  it.each([
    '',
    'bridge.local',
    '//bridge.local:3080',
    'ftp://bridge.local:3080',
    'ws://bridge.local:3080',
    'javascript:alert(1)',
    'file:///bridge',
    'http://user@bridge.local:3080',
    'https://user:secret@bridge.local',
    'http://bridge.local:0',
    'http://bridge.local:65536',
    'http://bridge.local:not-a-port',
    'http://[broken',
    'http://',
    'http://bridge.local/a b',
    'http://bridge.local\\evil',
    'http://bridge.local/\u0000',
    'http://bridge.local/\npath',
    '{broken}',
    '{"url":42}',
    '{"address":"http://bridge.local:3080"}',
  ])('rejects invalid or unsafe address %j', (raw) => {
    expect(parseQrPayload(raw)).toBeNull()
  })

  it('rejects oversized QR payloads before parsing', () => {
    expect(parseQrPayload(`http://bridge.local/${'x'.repeat(8192)}`)).toBeNull()
  })

  it('accepts the 8192-character boundary', () => {
    const raw = `http://bridge.local/${'x'.repeat(8172)}`
    expect(raw).toHaveLength(8192)
    expect(parseQrPayload(raw)).toEqual({
      id: 'http://bridge.local',
      url: raw,
      host: 'bridge.local',
      port: 80,
    })
  })

  it('decodes a JSON QR and removes every secret query value without losing route or public query', () => {
    expect(parseQrPayload(' {"url":" https://BRIDGE.local:443/workspaces/w-1?theme=dark&auth=a%2Bb&token=ignored&auth=again&session=s-7#private ","token":"untrusted"} ')).toEqual({
      id: 'https://bridge.local',
      url: 'https://bridge.local/workspaces/w-1?theme=dark&session=s-7',
      host: 'bridge.local',
      port: 443,
      token: 'a+b',
    })
  })

  it('accepts host:port shorthand with a token and preserves its path', () => {
    expect(parseQrPayload(' 192.168.7.20:3082/projects?token=scan-secret&view=compact ')).toEqual({
      id: 'http://192.168.7.20:3082',
      url: 'http://192.168.7.20:3082/projects?view=compact',
      host: '192.168.7.20',
      port: 3082,
      token: 'scan-secret',
    })
  })

  it('does not retain an empty token or fragment', () => {
    expect(parseQrPayload('http://bridge.local:3080/?auth=&token=other#token=fragment')).toEqual({
      id: 'http://bridge.local:3080',
      url: 'http://bridge.local:3080/',
      host: 'bridge.local',
      port: 3080,
    })
  })

  it.each([
    ['http://BRIDGE.local', 'http://bridge.local', 'http://bridge.local/', 'bridge.local', 80, false],
    ['http://bridge.local:80/a', 'http://bridge.local', 'http://bridge.local/a', 'bridge.local', 80, false],
    ['https://bridge.local', 'https://bridge.local', 'https://bridge.local/', 'bridge.local', 443, false],
    ['https://bridge.local:443/b', 'https://bridge.local', 'https://bridge.local/b', 'bridge.local', 443, false],
    ['http://bridge.local:65535/c', 'http://bridge.local:65535', 'http://bridge.local:65535/c', 'bridge.local', 65535, false],
    ['https://bridge.local:8443/d', 'https://bridge.local:8443', 'https://bridge.local:8443/d', 'bridge.local', 8443, false],
    ['http://[2001:db8::1]:3080/e', 'http://[2001:db8::1]:3080', 'http://[2001:db8::1]:3080/e', '[2001:db8::1]', 3080, true],
    ['http://[fd00::1]:3080/e', 'http://[fd00::1]:3080', 'http://[fd00::1]:3080/e', '[fd00::1]', 3080, false],
  ])('normalizes the stable origin and port of %s', (raw, id, url, host, port, remote) => {
    expect(parseQrPayload(raw)).toEqual(remote ? { id, url, host, port, remote: true } : { id, url, host, port })
  })
})

describe('remote host detection', () => {
  it.each([
    ['tunnel.example.com', true],
    ['dsh.example.com', true],
    ['8.8.8.8', true],
    ['[2001:db8::1]', true],
    ['192.168.1.10', false],
    ['10.0.0.2', false],
    ['172.16.4.4', false],
    ['127.0.0.1', false],
    ['169.254.1.1', false],
    ['bridge.local', false],
    ['dsh.lan', false],
    ['printer.internal', false],
    ['[fd00::1]', false],
    ['[::1]', false],
  ])('treats %s as remote=%s', (host, remote) => {
    expect(isRemoteHost(host)).toBe(remote)
  })

  it('marks a parsed public address as remote while leaving LAN addresses unmarked', () => {
    expect(parseQrPayload('https://dsh.example.com/')).toMatchObject({ remote: true })
    expect(parseQrPayload('http://192.168.1.10:3088/')?.remote).toBeUndefined()
  })
})

describe('parseAddressInput', () => {
  it('keeps an empty draft neutral instead of flagging it as invalid', () => {
    expect(parseAddressInput('   ')).toEqual({ address: null, invalid: false })
  })

  it.each([
    ['192.168.1.10:3088', 'http://192.168.1.10:3088', 3088],
    ['0.0.0.0:3088', 'http://0.0.0.0:3088', 3088],
    ['dsh.example.com', 'https://dsh.example.com', 443],
    ['https://tunnel.example.com/', 'https://tunnel.example.com', 443],
    ['http://bridge.local:3080/workspaces?theme=dark', 'http://bridge.local:3080', 3080],
  ])('connects the typed address %s', (raw, id, port) => {
    const { address, invalid } = parseAddressInput(raw)

    expect(invalid).toBe(false)
    expect(address).toMatchObject({ id, port })
  })

  it('keeps the typed route on the connect URL while the origin stays stable', () => {
    expect(parseAddressInput('http://bridge.local:3080/workspaces?theme=dark').address).toEqual({
      id: 'http://bridge.local:3080',
      url: 'http://bridge.local:3080/workspaces?theme=dark',
      host: 'bridge.local',
      port: 3080,
    })
  })

  it('keeps a typed pairing code out of the address and into the token', () => {
    expect(parseAddressInput('192.168.1.10:3088/?auth=K7M2Q9XA').address).toEqual({
      id: 'http://192.168.1.10:3088',
      url: 'http://192.168.1.10:3088/',
      host: '192.168.1.10',
      port: 3088,
      token: 'K7M2Q9XA',
    })
  })

  it.each([
    'ftp://files.local',
    'bridge local',
    'http://bridge.local:99999',
    'http://bridge.local:99999/x',
    'bridge local',
  ])('flags %s as invalid instead of failing silently', (raw) => {
    expect(parseAddressInput(raw)).toEqual({ address: null, invalid: true })
  })
})

describe('rebuildAddress', () => {
  const existing = { id: 'http://old.local:3080', url: 'http://old.local:3080/tasks', host: 'old.local', port: 3080, token: 'saved-token', name: '工作电脑' }

  it('replaces the origin while keeping the saved token and display name', () => {
    expect(rebuildAddress(existing, 'https://new.example.com')).toEqual({
      id: 'https://new.example.com',
      url: 'https://new.example.com/',
      host: 'new.example.com',
      port: 443,
      token: 'saved-token',
      name: '工作电脑',
      remote: true,
    })
  })

  it('returns null for an invalid replacement so the caller can keep the old address', () => {
    expect(rebuildAddress(existing, 'ftp://nope.local')).toBeNull()
  })
})

describe('connect URL and label', () => {
  it('adds an encoded auth token without mutating the sanitized address', () => {
    const address = {
      id: 'https://bridge.local:8443',
      url: 'https://bridge.local:8443/workspaces/w-1?theme=dark&auth=old',
      host: 'bridge.local',
      port: 8443,
      token: 'a+b&?#',
    }
    expect(buildConnectUrl(address)).toBe('https://bridge.local:8443/workspaces/w-1?theme=dark&auth=a%2Bb%26%3F%23')
    expect(address.url).toBe('https://bridge.local:8443/workspaces/w-1?theme=dark&auth=old')
  })

  it('exchanges a device ticket only at its origin root without forwarding the deep route or public query', () => {
    const token = `v1.1700000000000.0.${'a'.repeat(64)}`
    const address = { id: 'https://bridge.local:8443', url: 'https://bridge.local:8443/tasks?session=7', host: 'bridge.local', port: 8443, token }
    expect(buildConnectUrl(address)).toBe(`https://bridge.local:8443/?auth=${token}`)
    expect(address.url).toBe('https://bridge.local:8443/tasks?session=7')
    expect(address.token).toBe(token)
  })

  it('keeps a token-free URL unchanged', () => {
    expect(buildConnectUrl({ id: 'http://bridge.local', url: 'http://bridge.local/tasks?session=7', host: 'bridge.local', port: 80 })).toBe('http://bridge.local/tasks?session=7')
  })

  it.each([
    [{ id: 'http://bridge.local', url: 'http://bridge.local/a', host: 'bridge.local', port: 80 }, 'bridge.local'],
    [{ id: 'https://bridge.local', url: 'https://bridge.local/a', host: 'bridge.local', port: 443 }, 'bridge.local'],
    [{ id: 'http://bridge.local:3082', url: 'http://bridge.local:3082/a', host: 'bridge.local', port: 3082 }, 'bridge.local:3082'],
    [{ id: 'http://[::1]:3080', url: 'http://[::1]:3080/', host: '[::1]', port: 3080 }, '[::1]:3080'],
  ])('labels %j without secrets or paths', (address, label) => {
    expect(connectionLabel(address)).toBe(label)
  })
})

describe('protocol response validation', () => {
  it.each([null, undefined, [], true, 1, 'object'])('does not treat %j as a record', (value) => {
    expect(isRecord(value)).toBe(false)
  })

  it('accepts plain records', () => {
    expect(isRecord({ enabled: false })).toBe(true)
  })

  it.each([
    null,
    [],
    {},
    { name: 'DeepSeek Harness' },
    { short_name: 'DSH' },
    { name: 'Deepseek Harness', short_name: 'DSH' },
    { name: 'DeepSeek Harness', short_name: 'dsh' },
    { name: 'Other app', short_name: 'DSH' },
  ])('rejects a manifest without the exact DSH identity: %j', (value) => {
    expect(isBridgeManifest(value)).toBe(false)
  })

  it('recognizes the literal DSH manifest identity', () => {
    expect(isBridgeManifest({ name: 'DeepSeek Harness', short_name: 'DSH', start_url: '/' })).toBe(true)
  })
})

describe('isTrustedOrigin', () => {
  it.each([
    ['https://BRIDGE.local:443/a?auth=secret#fragment', 'https://bridge.local/path', true],
    ['http://bridge.local:80/a', 'http://bridge.local/', true],
    ['https://bridge.local:8443/a', 'https://bridge.local:8443/', true],
    ['https://bridge.local:8444/', 'https://bridge.local:8443/', false],
    ['http://bridge.local/', 'https://bridge.local/', false],
    ['https://bridge.local.evil.test/', 'https://bridge.local/', false],
    ['https://bridge.local@evil.test/', 'https://bridge.local/', false],
    ['javascript:alert(1)', 'https://bridge.local/', false],
    ['not a URL', 'https://bridge.local/', false],
    ['https://bridge.local/', 'not a URL', false],
  ])('checks complete origin equality for %s against %s', (candidate, expected, trusted) => {
    expect(isTrustedOrigin(candidate, expected)).toBe(trusted)
  })
})
