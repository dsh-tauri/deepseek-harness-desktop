import type { AccessAddress, AccessBody, AccessEvent, AccessLinkSource, AccessPairing, AccessScope, AccessState, AccessStatus, AccessTunnel, ServiceResult, TunnelBody, TunnelMode, TunnelProgress, TunnelProgressStage, TunnelState } from '../types/index'
import { ofetch as request } from 'dsh-tauri/client'
import { messageOf } from '../../shared/error'
import { store } from '../store/index'

const BASE = '/api/tauri/remote/access'

const SCOPES: readonly AccessScope[] = ['public_only', 'all']
const LINK_SOURCES: readonly AccessLinkSource[] = ['loopback', 'lan']
const ACCESS_STATES: readonly AccessState[] = ['stopped', 'listening', 'error']
const TUNNEL_MODES: readonly TunnelMode[] = ['quick', 'token']
const TUNNEL_STATES: readonly TunnelState[] = ['stopped', 'starting', 'running', 'error']
const TUNNEL_PROGRESS_STAGES: readonly TunnelProgressStage[] = ['check', 'download', 'extract', 'verify', 'spawn', 'domain', 'ready']

const EMPTY_TUNNEL: AccessTunnel = { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] }

export async function load(): Promise<void> {
  store.access.beginLoad()
  await refresh()
}

export async function refresh(): Promise<void> {
  const mine = store.access.beginRequest()
  try {
    store.access.commit(accessStatusOf(await request<unknown>(BASE, { method: 'get' })), mine)
  }
  catch (error) {
    store.access.fail(messageOf(error), mine)
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

async function mutate(run: () => Promise<unknown>): Promise<ServiceResult> {
  const mine = store.access.invalidateRequests()
  store.access.beginBusy()
  try {
    const next = accessStatusOf(await run())
    const refreshed = store.access.savedSeq > mine
    store.access.invalidateRequests()
    if (refreshed)
      await refresh()
    else
      store.access.commit(next)
    return { ok: true }
  }
  catch (error) {
    const message = messageOf(error)
    store.access.invalidateRequests()
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
    ...linkSourceField(raw.linkSource),
    ...textField('link', raw.link),
    ...textField('maskLink', raw.maskLink),
    ...textField('qr', raw.qr),
    ...textField('error', raw.error),
    ...numberField('localPort', raw.localPort),
    ...warningsField(raw.warnings),
    ...pairingField(raw.pairing),
  }
}

function pairingField(value: unknown): { pairing?: AccessPairing } {
  const raw = recordOf(value)
  const code = textOf(raw.code)
  const expiresAt = numberOf(raw.expiresAt)
  if (code === undefined || expiresAt === undefined)
    return {}
  const link = textOf(raw.link)
  const qr = textOf(raw.qr)
  const tunnelLink = textOf(raw.tunnelLink)
  const tunnelQr = textOf(raw.tunnelQr)
  const usedSeq = numberOf(raw.usedSeq)
  return { pairing: { code, expiresAt, ...usedSeq !== undefined && Number.isSafeInteger(usedSeq) && usedSeq >= 0 ? { usedSeq } : {}, ...link === undefined ? {} : { link }, ...qr === undefined ? {} : { qr }, ...tunnelLink === undefined ? {} : { tunnelLink }, ...tunnelQr === undefined ? {} : { tunnelQr } } }
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
    ...booleanField('hasToken', raw.hasToken),
    ...textField('token', raw.token),
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
    ...progressField(raw.progress),
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

function progressField(value: unknown): { progress: TunnelProgress } | Record<string, never> {
  const raw = recordOf(value)
  const stage = TUNNEL_PROGRESS_STAGES.find(candidate => candidate === raw.stage)
  if (stage === undefined)
    return {}
  return {
    progress: {
      stage,
      ...textField('url', raw.url),
      ...numberField('received', raw.received),
      ...numberField('total', raw.total),
    },
  }
}

function linkSourceField(value: unknown): { linkSource: AccessLinkSource } | Record<string, never> {
  const source = LINK_SOURCES.find(candidate => candidate === value)
  return source === undefined ? {} : { linkSource: source }
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
