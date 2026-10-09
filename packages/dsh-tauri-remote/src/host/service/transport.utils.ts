import type { RemoteConnectFailureKind } from './transport.types'
import { get as httpGet } from 'node:http'

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
])

function isUnreachable(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== undefined && UNREACHABLE_CODES.has(code))
    return true
  return /timed?\s?out|connection refused|econnrefused|no route to host|name or service not known|getaddrinfo/iu.test(error.message)
}

export function classifyConnectFailure(error: unknown, passwordOffered: boolean): RemoteConnectFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = error instanceof Error ? error : new Error(message)
  if (isUnreachable(normalized))
    return 'unreachable'
  if (/all configured authentication methods failed|authentication failed|no supported authentication/iu.test(message))
    return passwordOffered ? 'password-rejected' : 'key-rejected'
  return 'other'
}

export function describeConnectFailure(kind: RemoteConnectFailureKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (kind) {
    case 'key-rejected':
      return 'authentication failed: no key or ssh-agent was accepted — check your keys or store a password for this machine'
    case 'password-rejected':
      return 'authentication failed: the stored password was rejected — update the stored password'
    case 'unreachable':
      return `host unreachable: ${message === '' ? 'SSH connection failed' : message}`
    default:
      return message === '' ? 'SSH connection failed' : message
  }
}

export function injectCookieHead(head: string, cookie: string): string {
  const lines = head.split('\r\n')
  const isUpgrade = lines.some(line => /^connection:\s*upgrade/iu.test(line))
  const kept = lines.filter(line =>
    !/^cookie:/iu.test(line) && (isUpgrade || !/^connection:/iu.test(line)))
  kept.splice(1, 0, `Cookie: ${cookie}`)
  if (!isUpgrade)
    kept.splice(2, 0, 'Connection: close')
  return kept.join('\r\n')
}

export function mintTunnelCookie(authenticatedUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = httpGet(authenticatedUrl, (response) => {
      response.resume()
      const raw = response.headers['set-cookie']?.[0]
      const pair = raw === undefined ? undefined : raw.split(';')[0]?.trim()
      resolve(pair === undefined || pair === '' ? undefined : pair)
    })
    request.on('error', () => resolve(undefined))
    request.setTimeout(3_000, () => {
      request.destroy()
      resolve(undefined)
    })
  })
}
