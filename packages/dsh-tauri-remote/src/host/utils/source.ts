import type { IncomingHttpHeaders } from 'node:http'
import type { RemoteAccessDecision, RemoteAuthPolicy, RemoteSourceClass } from '../types/index'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { GATEWAY_SESSION_HEADER, GATEWAY_SOURCE_HEADER } from '../config/constants'
import { isPasswordRecordUsable } from './auth'

export type PeerSourceClass = Exclude<RemoteSourceClass, 'tunnel'>

const SOURCE_CLASSES: readonly RemoteSourceClass[] = ['loopback', 'private', 'public', 'tunnel']

/** TCP 对端地址分类（S2 §7.1）：127/8 与 ::1 回环；10/8、172.16/12、192.168/16、169.254/16、100.64/10 与 fc00::/7、fe80::/10 私网；其余公网。 */
export function classifyPeer(address: string | undefined): PeerSourceClass {
  const host = mappedHost(address)
  if (host === '')
    return 'public'
  return host.includes(':') ? classifyIpv6(host) : classifyIpv4(host)
}

export function isLoopbackPeer(address: string | undefined): boolean {
  return classifyPeer(address) === 'loopback'
}

/**
 * 来源分类判定：两枚内部标识头都不存在时回退 TCP 对端地址；任一枚存在则必须两枚同时有效
 * （单值 + 会话标识匹配 + 取值合法）才采用其声明，否则一律按不可信处理——网关转发到本机 DSH
 * 时对端恒为回环，回退会把伪造头变成回环权限。转发头（X-Forwarded-For 等）不参与判定。
 */
export function classifySource(headers: IncomingHttpHeaders, peerAddress: string | undefined, session: string): RemoteSourceClass {
  const declared = headers[GATEWAY_SOURCE_HEADER]
  const token = headers[GATEWAY_SESSION_HEADER]
  if (declared === undefined && token === undefined)
    return classifyPeer(peerAddress)
  if (typeof declared !== 'string' || typeof token !== 'string')
    return 'public'
  if (session === '' || !sessionMatches(token, session))
    return 'public'
  return isSourceClass(declared) ? declared : 'public'
}

export function isLoopbackSource(headers: IncomingHttpHeaders, peerAddress: string | undefined, session: string): boolean {
  return classifySource(headers, peerAddress, session) === 'loopback'
}

/** 认证配置是否成立：启用且至少存在一种**可用**凭据（未损坏的密码记录或非空链接 Token），否则等同未配置（S2 §7.4/§11）。 */
export function isAuthConfigured(policy: RemoteAuthPolicy | undefined): policy is RemoteAuthPolicy {
  if (policy === undefined || !policy.enabled)
    return false
  return isPasswordRecordUsable(policy.password) || (policy.linkToken !== null && policy.linkToken !== '')
}

/** 凭据存在但不可用（密码记录损坏且无链接 Token）→ 引导「重新设置密码」而不是空白的未配置拒绝（S2 §11）。 */
export function isAuthStorageBroken(policy: RemoteAuthPolicy | undefined): boolean {
  return policy !== undefined && policy.enabled && policy.password !== null && !isAuthConfigured(policy)
}

/** 判定矩阵（S2 §7.2）：回环恒放行，不提供 lan_only 档位。 */
export function decideSourceAccess(source: RemoteSourceClass, policy: RemoteAuthPolicy | undefined): RemoteAccessDecision {
  if (source === 'loopback')
    return 'allow'
  if (!isAuthConfigured(policy))
    return source === 'private' ? 'allow' : 'deny'
  if (source === 'private' && policy.scope === 'public_only')
    return 'allow'
  return 'authenticate'
}

/** 限速分桶键：仅隧道来源（内部标识可信）允许采用隧道侧声明的客户端 IP，且只影响分桶（S2 §7.1/§7.4）。 */
export function rateLimitKeyOf(source: RemoteSourceClass, peerAddress: string | undefined, declaredClientIp: string | undefined): string {
  if (source === 'tunnel' && isIpAddress(declaredClientIp))
    return declaredClientIp
  return peerAddress === undefined || peerAddress === '' ? 'unknown' : peerAddress
}

export function isIpAddress(value: string | undefined): value is string {
  if (value === undefined || value === '')
    return false
  const host = mappedHost(value)
  return host.includes(':') ? /^[0-9a-f:]+$/i.test(host) : classifyIpv4Shape(host)
}

// --- internal ---
function mappedHost(address: string | undefined): string {
  if (address === undefined)
    return ''
  const withoutZone = address.split('%')[0] ?? ''
  return /^::ffff:/i.test(withoutZone) ? withoutZone.slice(7) : withoutZone
}

function classifyIpv4(host: string): PeerSourceClass {
  const octets = host.split('.').map(octetOf)
  const [first, second] = octets
  if (octets.length !== 4 || first === undefined || second === undefined || octets.includes(undefined))
    return 'public'
  if (first === 127)
    return 'loopback'
  if (first === 10 || (first === 192 && second === 168) || (first === 169 && second === 254))
    return 'private'
  if (first === 172 && second >= 16 && second <= 31)
    return 'private'
  if (first === 100 && second >= 64 && second <= 127)
    return 'private'
  return 'public'
}

function classifyIpv6(host: string): PeerSourceClass {
  const lower = host.toLowerCase()
  if (lower === '::1')
    return 'loopback'
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower))
    return 'private'
  return 'public'
}

function classifyIpv4Shape(host: string): boolean {
  const octets = host.split('.').map(octetOf)
  return octets.length === 4 && octets.every(octet => octet !== undefined)
}

function octetOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,3}$/.test(value))
    return undefined
  const parsed = Number(value)
  return parsed <= 255 ? parsed : undefined
}

function isSourceClass(value: string): value is RemoteSourceClass {
  return (SOURCE_CLASSES as readonly string[]).includes(value)
}

function sessionMatches(token: string, session: string): boolean {
  const left = Buffer.from(token)
  const right = Buffer.from(session)
  return left.length === right.length && timingSafeEqual(left, right)
}
