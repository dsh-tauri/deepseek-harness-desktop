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
