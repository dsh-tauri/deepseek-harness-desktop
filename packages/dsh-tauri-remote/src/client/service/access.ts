import type { AccessAddress, AccessBody, AccessEvent, AccessScope, AccessState, AccessStatus, AccessTunnel, ServiceResult, TunnelBody, TunnelMode, TunnelState } from '../types/index'
import { ofetch as request } from 'dsh-tauri/client'
import { messageOf } from '../../shared/error'
import { store } from '../store/index'

const BASE = '/api/desktop/dsh-tauri-remote/access'

const SCOPES: readonly AccessScope[] = ['public_only', 'all']
const ACCESS_STATES: readonly AccessState[] = ['stopped', 'listening', 'error']
const TUNNEL_MODES: readonly TunnelMode[] = ['quick', 'token']
const TUNNEL_STATES: readonly TunnelState[] = ['stopped', 'starting', 'running', 'error']

const EMPTY_TUNNEL: AccessTunnel = { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] }

export async function load(): Promise<void> {
  store.access.beginLoad()
  await refresh()
}

/** 轮询用：不改状态机的 loading 档，避免面板在后台刷新时闪回加载态。 */
export async function refresh(): Promise<void> {
  try {
    store.access.commit(accessStatusOf(await request<unknown>(BASE, { method: 'get' })))
  }
  catch (error) {
    store.access.fail(messageOf(error))
  }
}

export async function apply(body: AccessBody): Promise<ServiceResult> {
  return await mutate(async () => await request<unknown>(BASE, { method: 'post', body }))
}

export async function rotateToken(): Promise<ServiceResult> {
  return await mutate(async () => await request<unknown>(`${BASE}/token`, { method: 'post' }))
}

export async function revokeToken(): Promise<ServiceResult> {
  return await mutate(async () => await request<unknown>(`${BASE}/token`, { method: 'delete' }))
}

export async function startTunnel(body: TunnelBody): Promise<ServiceResult> {
  return await mutate(async () => await request<unknown>(`${BASE}/tunnel`, { method: 'post', body }))
}

export async function stopTunnel(): Promise<ServiceResult> {
  return await mutate(async () => await request<unknown>(`${BASE}/tunnel`, { method: 'delete' }))
}

// --- internal ---
async function mutate(run: () => Promise<unknown>): Promise<ServiceResult> {
  store.access.beginBusy()
  try {
    store.access.commit(accessStatusOf(await run()))
    return { ok: true }
  }
  catch (error) {
    const message = messageOf(error)
    store.access.fail(message)
    return { ok: false, error: message }
  }
  finally {
    store.access.endBusy()
  }
}

function accessStatusOf(value: unknown): AccessStatus {
  const raw = recordOf(value)
  const listening = booleanOf(raw.listening) ?? false
  const tunnel = tunnelOf(raw.tunnel)
  return {
    version: numberOf(raw.version) ?? 1,
    enabled: booleanOf(raw.enabled) ?? false,
    state: stateOf(raw.state) ?? (listening ? 'listening' : 'stopped'),
    listening,
    listen: listenOf(raw.listen),
    port: numberOf(raw.port) ?? 0,
    auth: authOf(raw.auth),
    addresses: listOf(raw.addresses).map(addressOf).filter(entry => entry !== undefined),
    tunnel,
    events: listOf(raw.events).map(eventOf).filter(entry => entry !== undefined),
    ...textField('recommended', raw.recommended),
    ...textField('link', raw.link),
    ...textField('maskLink', raw.maskLink),
    ...textField('qr', raw.qr),
    ...textField('error', raw.error),
    ...numberField('localPort', raw.localPort),
    ...warningsField(raw.warnings),
  }
}

function listenOf(value: unknown): { address: string, port: number } {
  const raw = recordOf(value)
  return { address: textOf(raw.address) ?? '127.0.0.1', port: numberOf(raw.port) ?? 3088 }
}

function authOf(value: unknown): AccessStatus['auth'] {
  const raw = recordOf(value)
  return {
    enabled: booleanOf(raw.enabled) ?? false,
    scope: scopeOf(raw.scope) ?? 'public_only',
    ...booleanField('hasPassword', raw.hasPassword),
    ...booleanField('hasToken', raw.hasToken),
  }
}

function addressOf(value: unknown): AccessAddress | undefined {
  const raw = recordOf(value)
  const address = textOf(raw.address)
  if (address === undefined)
    return undefined
  return {
    address,
    family: textOf(raw.family) ?? (address.includes(':') ? 'ipv6' : 'ipv4'),
    interface: textOf(raw.interface) ?? '',
    scope: textOf(raw.scope) ?? 'private',
    score: numberOf(raw.score) ?? 0,
    recommended: booleanOf(raw.recommended) ?? false,
  }
}

function tunnelOf(value: unknown): AccessTunnel {
  const raw = recordOf(value)
  if (Object.keys(raw).length === 0)
    return { ...EMPTY_TUNNEL }
  return {
    enabled: booleanOf(raw.enabled) ?? false,
    mode: modeOf(raw.mode) ?? 'quick',
    hostname: textOf(raw.hostname) ?? null,
    state: tunnelStateOf(raw.state) ?? 'stopped',
    events: listOf(raw.events).map(eventOf).filter(entry => entry !== undefined),
    ...textField('token', raw.token),
    ...textField('url', raw.url),
    ...textField('link', raw.link),
    ...textField('qr', raw.qr),
    ...textField('error', raw.error),
    ...numberField('port', raw.port),
  }
}

function eventOf(value: unknown): AccessEvent | undefined {
  const raw = recordOf(value)
  const line = textOf(raw.line)
  if (line === undefined)
    return undefined
  return { seq: numberOf(raw.seq) ?? 0, ts: textOf(raw.ts) ?? '', kind: textOf(raw.kind) ?? 'state', line }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stateOf(value: unknown): AccessState | undefined {
  return ACCESS_STATES.find(candidate => candidate === value)
}

function scopeOf(value: unknown): AccessScope | undefined {
  return SCOPES.find(candidate => candidate === value)
}

function modeOf(value: unknown): TunnelMode | undefined {
  return TUNNEL_MODES.find(candidate => candidate === value)
}

function tunnelStateOf(value: unknown): TunnelState | undefined {
  return TUNNEL_STATES.find(candidate => candidate === value)
}

function textField<K extends string>(key: K, value: unknown): Record<K, string> | Record<string, never> {
  const text = textOf(value)
  return text === undefined ? {} : { [key]: text } as Record<K, string>
}

function numberField<K extends string>(key: K, value: unknown): Record<K, number> | Record<string, never> {
  const number = numberOf(value)
  return number === undefined ? {} : { [key]: number } as Record<K, number>
}

function booleanField<K extends string>(key: K, value: unknown): Record<K, boolean> | Record<string, never> {
  const boolean = booleanOf(value)
  return boolean === undefined ? {} : { [key]: boolean } as Record<K, boolean>
}

function warningsField(value: unknown): { warnings: string[] } | Record<string, never> {
  const warnings = listOf(value).map(textOf).filter(entry => entry !== undefined)
  return warnings.length === 0 ? {} : { warnings }
}
