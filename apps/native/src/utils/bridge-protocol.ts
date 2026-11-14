import type { BridgeManifest } from '@/apis/index.types'

export interface BridgeAddress {
  id: string
  url: string
  host: string
  port: number
  token?: string
  name?: string
  remote?: boolean
}

export interface AddressInputResult {
  address: BridgeAddress | null
  invalid: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBridgeManifest(value: unknown): value is BridgeManifest {
  return isRecord(value) && value.name === 'DeepSeek Harness' && value.short_name === 'DSH'
}

/** 公网隧道/远程入口：域名解析到公网地址，或本身是公网 IP，LAN 局域网扫描永远到不了。 */
export function isRemoteHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  const ipv4 = parseIpv4Octets(name)
  if (ipv4)
    return !isPrivateIpv4(ipv4)
  if (name.includes(':'))
    return !isPrivateIpv6(name)
  if (!name.includes('.'))
    return false
  return !isPrivateDomain(name)
}

export function parseQrPayload(raw: string): BridgeAddress | null {
  if (raw.length > 8192)
    return null
  let text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const data: unknown = JSON.parse(text)
      if (!isRecord(data) || typeof data.url !== 'string')
        return null
      text = data.url.trim()
    }
    catch {
      return null
    }
  }
  if (/^[\w.-]+:\d+(?:[/?].*)?$/.test(text))
    text = `http://${text}`
  if (!/^https?:\/\//i.test(text) || /[\s\\]/.test(text) || Array.from(text).some(character => character.charCodeAt(0) < 32))
    return null
  try {
    const url = new URL(text)
    if (url.username || url.password || !url.hostname)
      return null
    let port = 80
    if (url.protocol === 'https:')
      port = 443
    if (url.port)
      port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return null
    const token = url.searchParams.get('auth') ?? url.searchParams.get('token') ?? undefined
    url.searchParams.delete('auth')
    url.searchParams.delete('token')
    url.hash = ''
    const address: BridgeAddress = {
      id: url.origin,
      url: url.toString(),
      host: url.hostname,
      port,
    }
    if (token)
      address.token = token
    if (isRemoteHost(url.hostname))
      address.remote = true
    return address
  }
  catch {
    return null
  }
}

/** 手动输入的地址：协议可省略；带空格、缺少端口分隔符等输入判为非法而不是静默失败。 */
export function parseAddressInput(raw: string): AddressInputResult {
  const text = raw.trim()
  if (!text)
    return { address: null, invalid: false }
  const address = parseQrPayload(text)
    ?? (text.includes('://') || /[\s/?#\\]/.test(text) ? null : parseQrPayload(`https://${text}`))
  return { address, invalid: address === null }
}

/** 按新的 origin 与路径重建地址，令牌保持不动。 */
export function rebuildAddress(address: BridgeAddress, raw: string): BridgeAddress | null {
  const next = parseQrPayload(raw)
  if (!next)
    return null
  const token = address.token
  const name = address.name
  if (token)
    next.token = token
  if (name)
    next.name = name
  return next
}

export function isDeviceSession(value: unknown): value is string {
  return typeof value === 'string' && /^v1\.(?:0|[1-9]\d{0,15})\.0\.[a-f0-9]{64}$/u.test(value)
    && Number.isSafeInteger(Number(value.split('.')[1]))
}

export function buildConnectUrl(address: BridgeAddress): string {
  const url = isDeviceSession(address.token) ? new URL('/', address.id) : new URL(address.url)
  if (address.token)
    url.searchParams.set('auth', address.token)
  return url.toString()
}

export function connectionLabel(address: BridgeAddress): string {
  if (address.name)
    return address.name
  const url = new URL(address.url)
  if (url.port)
    return `${address.host}:${address.port}`
  return address.host
}

export function isTrustedOrigin(candidate: string, expected: string): boolean {
  try {
    const url = new URL(candidate)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === new URL(expected).origin
  }
  catch {
    return false
  }
}

function parseIpv4Octets(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))
    return null
  const octets = host.split('.').map(Number)
  return octets.some(octet => octet < 0 || octet > 255) ? null : octets
}

function isPrivateIpv4(octets: number[]): boolean {
  const [first = 0, second = 0] = octets
  return first === 10
    || first === 127
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 169 && second === 254)
}

function isPrivateIpv6(host: string): boolean {
  return host === '::1'
    || host.startsWith('fe80:')
    || host.startsWith('fc')
    || host.startsWith('fd')
}

function isPrivateDomain(name: string): boolean {
  const suffix = name.endsWith('.') ? name.slice(0, -1) : name
  return ['localhost', '.localhost', '.local', '.lan', '.internal', '.home.arpa']
    .some(tld => suffix === tld.slice(1) || suffix.endsWith(tld))
}
