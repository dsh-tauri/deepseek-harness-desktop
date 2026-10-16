import type { BridgeManifest } from '@/apis/index.types'

export interface BridgeAddress {
  id: string
  url: string
  host: string
  port: number
  token?: string
  name?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBridgeManifest(value: unknown): value is BridgeManifest {
  return isRecord(value) && value.name === 'DeepSeek Harness' && value.short_name === 'DSH'
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
    return address
  }
  catch {
    return null
  }
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
