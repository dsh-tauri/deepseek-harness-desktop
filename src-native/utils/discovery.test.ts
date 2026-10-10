import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCandidates, parseIpv4 } from './discovery'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('unicast IPv4 validation', () => {
  it.each([
    ['', null],
    [' 192.168.1.2', null],
    ['192.168.1.2 ', null],
    ['192.168.1', null],
    ['192.168.1.2.3', null],
    ['192.168.1.-2', null],
    ['192.168.1.256', null],
    ['256.1.2.3', null],
    ['192.168.1.2/24', null],
    ['192.168.1.2:3080', null],
    ['::1', null],
    ['0.1.2.3', null],
    ['127.0.0.1', null],
    ['224.0.0.1', null],
    ['239.10.20.30', null],
    ['255.255.255.255', null],
    ['10.0.0.9', [10, 0, 0, 9]],
    ['172.16.50.254', [172, 16, 50, 254]],
    ['192.168.7.2', [192, 168, 7, 2]],
    ['223.255.255.254', [223, 255, 255, 254]],
  ])('parses only a valid unicast IPv4 address: %s', (ip, expected) => {
    expect(parseIpv4(ip)).toEqual(expected)
  })
})

describe('buildCandidates', () => {
  it.each(['', '127.0.0.1', '224.1.2.3', '::1', '192.168.1.256'])('does not scan an invalid subnet %s', (selfIp) => {
    expect(buildCandidates({ selfIp, ports: [9999] })).toEqual([])
  })

  it('scans the two literal default ports in port-major order while excluding self and network/broadcast addresses', () => {
    const candidates = buildCandidates({ selfIp: '192.168.7.12' })
    expect(candidates).toHaveLength(506)
    expect(candidates.slice(0, 3)).toEqual([
      { host: '192.168.7.1', port: 3082 },
      { host: '192.168.7.2', port: 3082 },
      { host: '192.168.7.3', port: 3082 },
    ])
    expect(candidates.slice(252, 255)).toEqual([
      { host: '192.168.7.254', port: 3082 },
      { host: '192.168.7.1', port: 3080 },
      { host: '192.168.7.2', port: 3080 },
    ])
    expect(candidates.at(-1)).toEqual({ host: '192.168.7.254', port: 3080 })
    expect(candidates.filter(candidate => ['192.168.7.0', '192.168.7.12', '192.168.7.255'].includes(candidate.host))).toEqual([])
    expect(new Set(candidates.map(candidate => `${candidate.host}:${candidate.port}`)).size).toBe(506)
  })

  it('deduplicates history ports and rejects zero, out-of-range, fractional and nonfinite ports', () => {
    const ports = [4444, 3080, 4444, 3082, 0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65535, 80]
    const candidates = buildCandidates({ selfIp: '10.0.0.9', ports })
    expect(candidates).toHaveLength(1265)
    expect([...new Set(candidates.map(candidate => candidate.port))]).toEqual([4444, 3080, 3082, 65535, 80])
    expect(candidates.filter(candidate => candidate.port === 4444)).toHaveLength(253)
    expect(candidates.filter(candidate => candidate.port === 65535)).toHaveLength(253)
    expect(ports).toEqual([4444, 3080, 4444, 3082, 0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65535, 80])
  })

  it('excludes an entire host or just an exact host:port without excluding sibling ports', () => {
    const candidates = buildCandidates({
      selfIp: '10.0.0.9',
      exclude: ['10.0.0.2', '10.0.0.3:3082', '10.0.1.4', '10.0.0.2'],
    })
    expect(candidates).toHaveLength(503)
    expect(candidates.slice(0, 2)).toEqual([
      { host: '10.0.0.1', port: 3082 },
      { host: '10.0.0.4', port: 3082 },
    ])
    expect(candidates.filter(candidate => candidate.host === '10.0.0.2')).toEqual([])
    expect(candidates.filter(candidate => candidate.host === '10.0.0.3')).toEqual([{ host: '10.0.0.3', port: 3080 }])
  })

  it('does not generate .0 or .255 even when self is a subnet boundary', () => {
    const candidates = buildCandidates({ selfIp: '10.0.0.0' })
    expect(candidates).toHaveLength(508)
    expect([...new Set(candidates.map(candidate => candidate.host))].slice(0, 2)).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(candidates.filter(candidate => candidate.host === '10.0.0.255')).toEqual([])
  })

  it('excludes the normalized self address when IPv4 octets have leading zeros', () => {
    const candidates = buildCandidates({ selfIp: '192.168.007.012' })
    expect(candidates).toHaveLength(506)
    expect(candidates.filter(candidate => candidate.host === '192.168.7.12')).toEqual([])
  })
})
