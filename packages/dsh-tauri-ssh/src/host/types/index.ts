import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Buffer } from 'node:buffer'

export type MachineId = string & { readonly __machineId: unique symbol }

// eslint-disable-next-line ts/no-redeclare -- 品牌类型惯用法：值与类型同名
export function MachineId(id: string): MachineId {
  return id as MachineId
}

export interface MachineProfile {
  id: MachineId
  name: string
  host: string
  port: number
  user: string
  password?: string
  passphrase?: string
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

export interface MachineView {
  id: MachineId
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

export interface MachineSaveRow {
  name: string
  host: string
  port: number
  user: string
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

export interface MachineSecretWrite {
  password?: string
  passphrase?: string
}

export type SshConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

export type SshAuthMethod = 'agent' | 'key' | 'password'

export type SshProgressPhase = 'handshake' | 'starting' | 'probing' | 'installing' | 'syncing'

export interface SshProgress {
  phase: SshProgressPhase
  attempt?: number
  total?: number
  item?: string
  log?: string
}

export interface SshMachineStatus {
  machineId: MachineId
  state: SshConnectionState
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  progress?: SshProgress
  nextRetryAt?: number
  authMethod?: SshAuthMethod
}

export interface SshLink {
  machineId: MachineId
  tunnelBaseUrl: string
}

export type SshTestResult
  = | { ok: true, banner: string }
    | { ok: false, message: string }

export type SshMachineStage
  = | 'probe'
    | 'download'
    | 'verify'
    | 'install'
    | 'launch'
    | 'ready'
    | 'failed'
    | 'auth'
    | 'reconnect'

export type SshMachineTerminal = 'success' | 'failed'

export interface SshMachineEvent {
  seq: number
  ts: string
  machineId: MachineId
  stage: SshMachineStage
  line: string
  terminal?: SshMachineTerminal
  reason?: string
}

export interface SshMachineEventsPage {
  events: SshMachineEvent[]
  nextSeq: number
}

export interface SshInstallResult {
  installed: string[]
  dshRef: string
  dshVersion: string
  dshPath: string
  credentialsCopied: boolean
  credentialsError?: string
}

export type SshErrorCode
  = | 'machine-not-found'
    | 'machine-connect-failed'
    | 'machine-bootstrap-failed'
    | 'machine-dsh-missing'
    | 'machine-install-failed'
    | 'machine-ssh-error'
    | 'machine-reconnecting'
    | 'machine-sync-failed'

export type SyncSkillRoot = 'dsh' | 'agents'

export interface SyncPluginItem {
  name: string
  spec: string
  syncable: boolean
  reason?: string
}

export interface SyncSkillItem {
  name: string
  root: SyncSkillRoot
}

export interface SyncPreview {
  plugins: SyncPluginItem[]
  skills: SyncSkillItem[]
}

export interface SyncPluginRef {
  name: string
  spec: string
}

export interface SyncSkillRef {
  name: string
  root: SyncSkillRoot
}

export interface SyncItemResult {
  kind: 'plugin' | 'skill'
  name: string
  root?: SyncSkillRoot
  ok: boolean
  error?: string
  log?: string
}

export interface SyncApplyResult {
  items: SyncItemResult[]
}

export class SshError extends Error {
  constructor(readonly code: SshErrorCode, readonly machineId: MachineId, message: string) {
    super(message)
    this.name = 'SshError'
  }
}

export interface SshExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface SshExecOptions {
  timeoutMs?: number
  onData?: (chunk: string) => void
  stdinData?: Buffer
}

export interface TunnelHeaderInjection {
  cookie: string | undefined
}

export interface SshTunnelHandle {
  localPort: number
  close: () => Promise<void>
}

export interface SshSession {
  readonly authMethod?: SshAuthMethod | undefined
  exec: (command: string, options?: SshExecOptions) => Promise<SshExecResult>
  openTunnel: (remotePort: number, preferredLocalPort?: number, injection?: TunnelHeaderInjection) => Promise<SshTunnelHandle>
  onClosed: (callback: () => void) => void
  close: () => Promise<void>
}

export type HostWebRoute = WebRoute

export interface HostWebServer {
  register: (route: HostWebRoute) => () => void
}

export interface SshHostContext {
  webServer: HostWebServer
  effect: (execute: () => (() => void) | void, label?: string) => unknown
}
