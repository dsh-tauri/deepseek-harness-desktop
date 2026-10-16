import type { AccessTunnel, TunnelBody, TunnelMode } from '../types/index'

export interface LanDraft {
  address: string
}

export interface TunnelDraft {
  mode: TunnelMode
  token: string | null
  hostname: string
}

export type TunnelField = 'token' | 'hostname'

export function countdownOf(expiresAt: number, now: number): string {
  const left = Math.floor((expiresAt - now) / 1000)
  if (left <= 0)
    return ''
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

export function lanDirtyOf(draft: LanDraft | null, listen: { address: string }): boolean {
  return draft !== null && draft.address !== listen.address
}

export function tunnelDraftOf(tunnel: AccessTunnel): TunnelDraft {
  return { mode: tunnel.mode, token: tunnel.token ?? null, hostname: tunnel.hostname ?? '' }
}

export function tunnelDirtyOf(draft: TunnelDraft | null, tunnel: AccessTunnel): boolean {
  if (draft === null)
    return false
  const saved = tunnelDraftOf(tunnel)
  return draft.mode !== saved.mode || draft.token !== saved.token || draft.hostname !== saved.hostname
}

export function tunnelMissingOf(draft: TunnelDraft): TunnelField | undefined {
  if (draft.mode !== 'token')
    return undefined
  if (draft.token === null || draft.token.trim() === '')
    return 'token'
  return draft.hostname.trim() === '' ? 'hostname' : undefined
}

export function tunnelBodyOf(draft: TunnelDraft): TunnelBody {
  const token = draft.token === null ? '' : draft.token.trim()
  const hostname = draft.hostname.trim()
  return {
    mode: draft.mode,
    ...token === '' ? {} : { token },
    ...hostname === '' ? {} : { hostname },
  }
}

export function maskAuthOf(link: string): string {
  return link.replace(/([?&]auth=)[^&]*/, '$1••••••')
}
