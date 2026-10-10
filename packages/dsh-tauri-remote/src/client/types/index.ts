export type MachineLifecycleState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

export interface ServiceResult {
  ok: boolean
  error?: string
}

export function isLifecycleState(value: unknown): value is MachineLifecycleState {
  return value === 'disconnected'
    || value === 'testing'
    || value === 'connecting'
    || value === 'connected'
    || value === 'reconnecting'
    || value === 'given-up'
}

export interface MachineRow {
  id: string
  name: string
  host: string
  port: number
  user: string
  hasPassword: boolean
  hasPassphrase: boolean
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

export interface SecretValues {
  password?: string
  passphrase?: string
}

export type ProgressPhase = 'handshake' | 'installing' | 'starting' | 'probing' | 'syncing'

export interface MachineStatus {
  state: MachineLifecycleState
  nextRetryAt?: number
  authMethod?: 'agent' | 'key' | 'password'
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  progress?: { phase: ProgressPhase, attempt?: number, total?: number, item?: string, log?: string }
}

export interface MachineListSnapshot {
  machines: MachineRow[]
  discovered: MachineRow[]
  statuses: Record<string, MachineStatus>
}

export interface InstallResult {
  dshPath: string
  credentialsCopied: boolean
  credentialsError?: string
}

export interface RemoteMachineEvent {
  seq: number
  ts: string
  machineId: string
  stage: string
  line: string
  terminal?: 'success' | 'failed'
  reason?: string
}

export interface SyncPluginItem {
  name: string
  spec: string
  syncable: boolean
  reason?: string
}

export interface SyncSkillItem {
  name: string
  root: string
}

export interface SyncPreview {
  plugins: SyncPluginItem[]
  skills: SyncSkillItem[]
}

export interface SyncItemResult {
  kind: 'plugin' | 'skill'
  name: string
  root?: string
  ok: boolean
  error?: string
  log?: string
}

export interface SyncApplyResult {
  items: SyncItemResult[]
}

export interface RemoteBridge {
  probe: () => Promise<unknown>
  openWindow: (machineId: string, url: string) => Promise<unknown>
}

export type AccessState = 'stopped' | 'listening' | 'error'

export type AccessScope = 'public_only' | 'all'

export type TunnelMode = 'quick' | 'token'

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error'

export interface AccessAddress {
  address: string
  family: string
  interface: string
  scope: string
  score: number
  recommended: boolean
}

export interface AccessEvent {
  seq: number
  ts: string
  kind: string
  line: string
}

export interface AccessTunnel {
  enabled: boolean
  mode: TunnelMode
  hostname: string | null
  state: TunnelState
  events: readonly AccessEvent[]
  token?: string
  url?: string
  port?: number
  link?: string
  qr?: string
  error?: string
}

export interface AccessStatus {
  version: number
  enabled: boolean
  state: AccessState
  listening: boolean
  listen: { address: string, port: number }
  port: number
  auth: { enabled: boolean, scope: AccessScope, hasPassword?: boolean, hasToken?: boolean }
  addresses: readonly AccessAddress[]
  recommended?: string
  link?: string
  maskLink?: string
  qr?: string
  tunnel: AccessTunnel
  localPort?: number
  error?: string
  warnings?: readonly string[]
  events: readonly AccessEvent[]
}

export interface AccessBody {
  enabled?: boolean
  address?: string
  port?: number
  authEnabled?: boolean
  scope?: AccessScope
  /** `null` 表示清除已设密码。 */
  password?: string | null
}

export interface TunnelBody {
  mode: TunnelMode
  token?: string
  hostname?: string
}
