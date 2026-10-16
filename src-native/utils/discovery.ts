import { DEFAULT_PORTS } from '@/config/constants'

export interface ScanCandidate {
  host: string
  port: number
}

export function parseIpv4(ip: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
    return null
  const octets = ip.split('.').map(Number)
  if (octets.some(value => value < 0 || value > 255))
    return null
  if (octets[0] === 0 || octets[0] === 127 || (octets[0] ?? 256) >= 224)
    return null
  return octets
}

export function buildCandidates({ selfIp, ports = [], exclude = [] }: {
  selfIp: string
  ports?: readonly number[]
  exclude?: readonly string[]
}): ScanCandidate[] {
  const octets = parseIpv4(selfIp)
  if (!octets)
    return []
  const prefix = octets.slice(0, 3).join('.')
  const allPorts = [...new Set([...ports, ...DEFAULT_PORTS])]
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
  const excluded = new Set([octets.join('.'), ...exclude])
  const candidates: ScanCandidate[] = []
  for (const port of allPorts) {
    for (let last = 1; last <= 254; last++) {
      const host = `${prefix}.${last}`
      if (!excluded.has(host) && !excluded.has(`${host}:${port}`))
        candidates.push({ host, port })
    }
  }
  return candidates
}
