import type { NetworkInterfaceInfo } from 'node:os'
import type { RemoteAuthPolicy, RemoteAuthScope, RemotePasswordRecord, RemoteTunnelStatus } from '../types/index'
import type { RemoteAccessAddress, RemoteAccessBody, RemoteAccessDocument, RemoteAccessParse, RemoteAccessStatus, RemoteAddressFamily, RemoteAddressScope } from './access.types'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname } from 'pathe'
import { accessDocumentPath } from '../config/runtime'
import { hashPassword } from '../utils/auth'
import { classifyPeer } from '../utils/source'

export const ACCESS_DOCUMENT_VERSION = 1

export const DEFAULT_ACCESS_ADDRESS = '127.0.0.1'

export const DEFAULT_ACCESS_PORT = 3088

const DOCUMENT_KEYS = new Set(['version', 'enabled', 'listen', 'auth', 'tunnel'])

const LISTEN_KEYS = new Set(['address', 'port'])

const AUTH_KEYS = new Set(['enabled', 'password', 'token', 'scope'])

const TUNNEL_KEYS = new Set(['enabled', 'mode', 'token', 'hostname'])

const SCOPES: readonly RemoteAuthScope[] = ['public_only', 'all']

/** 容器 / 虚拟机 / 隧道类网卡降权：物理网卡优先（S4 §7）。 */
const VIRTUAL_INTERFACE = /^(?:lo|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|utun|wg\d|zt|tailscale|ham|bridge|anpi|awdl|llw|ap\d|VirtualBox|Hyper-V)/i

const PHYSICAL_SCORE = 100

const VIRTUAL_SCORE = 30

const PRIVATE_SCORE = 20

const IPV4_SCORE = 5

const MASK = '***'

export function defaultAccessDocument(): RemoteAccessDocument {
  return {
    version: ACCESS_DOCUMENT_VERSION,
    enabled: false,
    listen: { address: DEFAULT_ACCESS_ADDRESS, port: DEFAULT_ACCESS_PORT },
    auth: { enabled: false, password: null, token: null, scope: 'public_only' },
    tunnel: { enabled: false, mode: 'quick', token: null, hostname: null },
  }
}

/** 解析失败视为「未配置」：回落默认文档 + `corrupt` 标记，调用方据此保留文件并给出可读原因（S4 §5）。 */
export function parseAccessDocument(text: string | undefined): RemoteAccessParse {
  const document = defaultAccessDocument()
  const warnings: string[] = []
  if (text === undefined || text.trim() === '')
    return { document, corrupt: false, warnings }
  const raw = plainObjectOf(text)
  if (raw === undefined)
    return { document, corrupt: true, warnings: ['access.json 解析失败，已按未配置处理（文件保留待手工修复）'] }
  for (const key of Object.keys(raw)) {
    if (!DOCUMENT_KEYS.has(key))
      warnings.push(`access.json 丢弃未知键 ${key}`)
  }
  readVersion(raw, document, warnings)
  readKnown(raw, document, warnings)
  return { document, corrupt: false, warnings }
}

export function serializeAccessDocument(document: RemoteAccessDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function readAccessDocument(): RemoteAccessParse {
  let text: string | undefined
  try {
    text = readFileSync(accessDocumentPath(), 'utf8')
  }
  catch {
    text = undefined
  }
  return parseAccessDocument(text)
}

export function writeAccessDocument(document: RemoteAccessDocument): void {
  const file = accessDocumentPath()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, serializeAccessDocument(document), { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function patchAccessDocument(document: RemoteAccessDocument, body: RemoteAccessBody, addresses: RemoteAccessAddress[]): RemoteAccessDocument {
  const next: RemoteAccessDocument = {
    version: ACCESS_DOCUMENT_VERSION,
    enabled: document.enabled,
    listen: { ...document.listen },
    auth: { ...document.auth },
    tunnel: document.tunnel,
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      throw new TypeError('invalid enabled')
    next.enabled = body.enabled
  }
  if (body.address !== undefined) {
    if (typeof body.address !== 'string' || !isSelectableAddress(body.address, addresses))
      throw new TypeError(`invalid address: ${String(body.address)}`)
    next.listen.address = body.address
  }
  if (body.port !== undefined) {
    if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535)
      throw new TypeError('invalid port')
    next.listen.port = body.port
  }
  if (body.authEnabled !== undefined) {
    if (typeof body.authEnabled !== 'boolean')
      throw new TypeError('invalid authEnabled')
    next.auth.enabled = body.authEnabled
  }
  if (body.scope !== undefined) {
    if (!isScope(body.scope))
      throw new TypeError('invalid scope')
    next.auth.scope = body.scope
  }
  if (body.password === null) {
    next.auth.password = null
  }
  else if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password === '')
      throw new TypeError('invalid password')
    next.auth.password = hashPassword(body.password)
  }
  return next
}

export function isSelectableAddress(address: string, addresses: RemoteAccessAddress[]): boolean {
  if (isWildcardListen(address) || isLoopbackListen(address))
    return true
  return addresses.some(entry => entry.address === address)
}

export function policyOf(document: RemoteAccessDocument, sessionSecret: string): RemoteAuthPolicy {
  return {
    enabled: document.auth.enabled,
    scope: document.auth.scope,
    password: document.auth.password,
    linkToken: document.auth.token,
    sessionSecret,
  }
}

export function enumerateAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): RemoteAccessAddress[] {
  const entries: RemoteAccessAddress[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal)
        continue
      const family: RemoteAddressFamily = info.family === 'IPv6' ? 'ipv6' : 'ipv4'
      entries.push({
        address: info.address,
        family,
        interface: name,
        scope: addressScopeOf(info.address),
        score: addressScoreOf(name, info.address),
        recommended: false,
      })
    }
  }
  return rankAddresses(entries)
}

export function rankAddresses(entries: RemoteAccessAddress[]): RemoteAccessAddress[] {
  const ranked = [...entries].sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
  const top = ranked.find(entry => isReachableAddress(entry.address))
  return ranked.map(entry => ({ ...entry, recommended: top !== undefined && entry.address === top.address }))
}

/** 对外可达地址：排除回环、link-local、带 zone id 的地址，以及 `0.0.0.0` 与 `::` 本身（S4 §7）。 */
export function isReachableAddress(address: string): boolean {
  if (address === '' || address.includes('%') || isWildcardListen(address))
    return false
  return !isLoopbackListen(address) && !isLinkLocalAddress(address)
}

export function isWildcardListen(address: string): boolean {
  return address === '0.0.0.0' || address === '::'
}

export function isLoopbackListen(address: string): boolean {
  return address === '::1' || classifyPeer(address) === 'loopback'
}

export function linkHostOf(listen: string, addresses: RemoteAccessAddress[]): string | undefined {
  if (isWildcardListen(listen))
    return addresses.find(entry => entry.recommended)?.address
  if (isLoopbackListen(listen))
    return listen
  return isReachableAddress(listen) ? listen : undefined
}

export function addressProblemOf(listen: string, addresses: RemoteAccessAddress[]): string | undefined {
  if (isWildcardListen(listen))
    return addresses.some(entry => entry.recommended) ? undefined : '当前没有任何可用的对外地址，请重新选择网卡'
  if (isLoopbackListen(listen))
    return undefined
  if (!addresses.some(entry => entry.address === listen))
    return `选定地址 ${listen} 已不存在，请重新选择网卡`
  return isReachableAddress(listen) ? undefined : `选定地址 ${listen} 不可用于对外访问（link-local 或带 zone id），请重新选择网卡`
}

export function buildLink(host: string, port: number, token: string | null): string {
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${port}/${token === null || token === '' ? '' : `?auth=${encodeURIComponent(token)}`}`
}

export function maskLinkOf(host: string, port: number, hasToken: boolean): string {
  return buildLink(host, port, hasToken ? MASK : null)
}

/** 公网隧道的访问链接：隧道地址本身已是 https，Token 语义与局域网链接一致。 */
export function buildTunnelLink(url: string, token: string | null): string {
  return token === null || token === '' ? `${url}/` : `${url}/?auth=${encodeURIComponent(token)}`
}

/** 脱敏（S4 §6）：只保留开关、监听、认证开关/scope 与凭据存在性、地址清单、掩码链接与状态，绝不带 Token / 二维码 / 本机明细。 */
export function redactStatus(status: RemoteAccessStatus): RemoteAccessStatus {
  return {
    version: status.version,
    enabled: status.enabled,
    state: status.state,
    listening: status.listening,
    listen: status.listen,
    port: status.port,
    auth: {
      enabled: status.auth.enabled,
      scope: status.auth.scope,
      ...status.auth.hasPassword === undefined ? {} : { hasPassword: status.auth.hasPassword },
      ...status.auth.hasToken === undefined ? {} : { hasToken: status.auth.hasToken },
    },
    addresses: status.addresses,
    events: status.events,
    ...status.recommended === undefined ? {} : { recommended: status.recommended },
    ...status.maskLink === undefined ? {} : { maskLink: status.maskLink },
    ...status.tunnel === undefined ? {} : { tunnel: redactTunnel(status.tunnel) },
    ...status.error === undefined ? {} : { error: status.error },
    ...status.warnings === undefined ? {} : { warnings: status.warnings },
  }
}

/** 隧道脱敏：保留配置与运行期状态，去掉凭据与只属于完整分支的链接/二维码。 */
export function redactTunnel(status: RemoteTunnelStatus): RemoteTunnelStatus {
  const { token, link, qr, ...rest } = status
  return rest
}

// --- internal ---
function readVersion(raw: Record<string, unknown>, document: RemoteAccessDocument, warnings: string[]): void {
  const version = raw.version
  if (typeof version === 'number' && Number.isInteger(version) && version > 0) {
    document.version = version
    return
  }
  if (version !== undefined)
    warnings.push('access.json 的 version 非法，已回落 1')
}

function readKnown(raw: Record<string, unknown>, document: RemoteAccessDocument, warnings: string[]): void {
  if (typeof raw.enabled === 'boolean')
    document.enabled = raw.enabled
  else if (raw.enabled !== undefined)
    warnings.push('access.json 的 enabled 非法，已回落 false')
  readListen(raw.listen, document, warnings)
  readAuth(raw.auth, document, warnings)
  readTunnel(raw.tunnel, document, warnings)
}

function readListen(value: unknown, document: RemoteAccessDocument, warnings: string[]): void {
  if (value === undefined)
    return
  if (!isPlainObject(value)) {
    warnings.push('access.json 的 listen 非法，已回落默认')
    return
  }
  for (const key of Object.keys(value)) {
    if (!LISTEN_KEYS.has(key))
      warnings.push(`access.json 丢弃未知键 listen.${key}`)
  }
  const address = value.address
  if (typeof address === 'string' && address !== '')
    document.listen.address = address
  else if (address !== undefined)
    warnings.push('access.json 的 listen.address 非法，已回落 127.0.0.1')
  const port = value.port
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535)
    document.listen.port = port
  else if (port !== undefined)
    warnings.push('access.json 的 listen.port 非法，已回落 3088')
}

function readAuth(value: unknown, document: RemoteAccessDocument, warnings: string[]): void {
  if (value === undefined)
    return
  if (!isPlainObject(value)) {
    warnings.push('access.json 的 auth 非法，已回落默认')
    return
  }
  for (const key of Object.keys(value)) {
    if (!AUTH_KEYS.has(key))
      warnings.push(`access.json 丢弃未知键 auth.${key}`)
  }
  if (typeof value.enabled === 'boolean')
    document.auth.enabled = value.enabled
  else if (value.enabled !== undefined)
    warnings.push('access.json 的 auth.enabled 非法，已回落 false')
  if (isScope(value.scope))
    document.auth.scope = value.scope
  else if (value.scope !== undefined)
    warnings.push('access.json 的 auth.scope 非法，已回落 public_only')
  if (value.password !== null && value.password !== undefined) {
    const record = passwordRecordOf(value.password)
    if (record === undefined)
      warnings.push('access.json 的 auth.password 非法，已丢弃')
    else
      document.auth.password = record
  }
  if (typeof value.token === 'string' && value.token !== '')
    document.auth.token = value.token
  else if (value.token !== undefined && value.token !== null)
    warnings.push('access.json 的 auth.token 非法，已丢弃')
}

function readTunnel(value: unknown, document: RemoteAccessDocument, warnings: string[]): void {
  if (value === undefined)
    return
  if (!isPlainObject(value)) {
    warnings.push('access.json 的 tunnel 非法，已回落默认')
    return
  }
  for (const key of Object.keys(value)) {
    if (!TUNNEL_KEYS.has(key))
      warnings.push(`access.json 丢弃未知键 tunnel.${key}`)
  }
  if (typeof value.enabled === 'boolean')
    document.tunnel.enabled = value.enabled
  else if (value.enabled !== undefined)
    warnings.push('access.json 的 tunnel.enabled 非法，已回落 false')
  if (value.mode === 'quick' || value.mode === 'token')
    document.tunnel.mode = value.mode
  else if (value.mode !== undefined)
    warnings.push('access.json 的 tunnel.mode 非法，已回落 quick')
  if (typeof value.token === 'string' && value.token !== '')
    document.tunnel.token = value.token
  else if (value.token !== undefined && value.token !== null)
    warnings.push('access.json 的 tunnel.token 非法，已丢弃')
  if (typeof value.hostname === 'string' && value.hostname !== '')
    document.tunnel.hostname = value.hostname
  else if (value.hostname !== undefined && value.hostname !== null)
    warnings.push('access.json 的 tunnel.hostname 非法，已丢弃')
}

/** 只校验形态、不校验可用性：损坏的记录必须原样保留，才能让 S2 的「认证存储损坏」引导生效（S2 §11）。 */
function passwordRecordOf(value: unknown): RemotePasswordRecord | undefined {
  if (!isPlainObject(value))
    return undefined
  const iterations = value.iterations
  if (value.algo !== 'pbkdf2-sha256' || typeof value.salt !== 'string' || typeof value.hash !== 'string')
    return undefined
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations <= 0)
    return undefined
  return { algo: 'pbkdf2-sha256', salt: value.salt, iterations, hash: value.hash }
}

function plainObjectOf(text: string): Record<string, unknown> | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return undefined
  }
  return isPlainObject(raw) ? raw : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScope(value: unknown): value is RemoteAuthScope {
  return (SCOPES as readonly unknown[]).includes(value)
}

function addressScopeOf(address: string): RemoteAddressScope {
  const peer = classifyPeer(address)
  if (peer === 'loopback')
    return 'loopback'
  if (isLinkLocalAddress(address))
    return 'link-local'
  return peer === 'private' ? 'private' : 'public'
}

function addressScoreOf(name: string, address: string): number {
  let score = VIRTUAL_INTERFACE.test(name) ? VIRTUAL_SCORE : PHYSICAL_SCORE
  if (classifyPeer(address) === 'private')
    score += PRIVATE_SCORE
  if (!address.includes(':'))
    score += IPV4_SCORE
  return score
}

function isLinkLocalAddress(address: string): boolean {
  const host = address.split('%')[0] ?? ''
  return host.includes(':') ? /^fe[89ab]/i.test(host) : host.startsWith('169.254.')
}
