import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildConnectUrl, connectionLabel, isBridgeManifest, isRecord, isTrustedOrigin, parseAuthStatus, parseQrPayload } from './bridge-protocol'

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
    ['http://BRIDGE.local', 'http://bridge.local', 'http://bridge.local/', 'bridge.local', 80],
    ['http://bridge.local:80/a', 'http://bridge.local', 'http://bridge.local/a', 'bridge.local', 80],
    ['https://bridge.local', 'https://bridge.local', 'https://bridge.local/', 'bridge.local', 443],
    ['https://bridge.local:443/b', 'https://bridge.local', 'https://bridge.local/b', 'bridge.local', 443],
    ['http://bridge.local:65535/c', 'http://bridge.local:65535', 'http://bridge.local:65535/c', 'bridge.local', 65535],
    ['https://bridge.local:8443/d', 'https://bridge.local:8443', 'https://bridge.local:8443/d', 'bridge.local', 8443],
    ['http://[2001:db8::1]:3080/e', 'http://[2001:db8::1]:3080', 'http://[2001:db8::1]:3080/e', '[2001:db8::1]', 3080],
  ])('normalizes the stable origin and port of %s', (raw, id, url, host, port) => {
    expect(parseQrPayload(raw)).toEqual({ id, url, host, port })
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
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: false, mode: null },
    { enabled: true, mode: 4 },
    { enabled: true, allowLoopback: 'true' },
    { enabled: true, allowLoopback: null },
  ])('rejects malformed auth status %j', (value) => {
    expect(parseAuthStatus(value)).toBeNull()
  })

  it('returns only validated auth fields', () => {
    expect(parseAuthStatus({ enabled: true, mode: 'token_only', allowLoopback: false, token: 'secret', extra: true })).toEqual({ enabled: true, mode: 'token_only', allowLoopback: false })
    expect(parseAuthStatus({ enabled: false })).toEqual({ enabled: false })
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
