import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type MachineId = string & { readonly __machineId: unique symbol }

// eslint-disable-next-line ts/no-redeclare -- 品牌类型惯用法：值与类型同名
export function MachineId(id: string): MachineId {
  return id as MachineId
}

export type MachineTransport = 'ssh'

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
  transport?: MachineTransport
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

export type RemoteConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

export type RemoteAuthMethod = 'agent' | 'key' | 'password'

export type RemoteProgressPhase = 'handshake' | 'starting' | 'probing' | 'installing' | 'syncing'

export interface RemoteProgress {
  phase: RemoteProgressPhase
  attempt?: number
  total?: number
  item?: string
  log?: string
}

export interface RemoteMachineStatus {
  machineId: MachineId
  state: RemoteConnectionState
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  progress?: RemoteProgress
  nextRetryAt?: number
  authMethod?: RemoteAuthMethod
}

export interface RemoteLink {
  machineId: MachineId
  tunnelBaseUrl: string
}

export type RemoteTestResult
  = | { ok: true, banner: string }
    | { ok: false, message: string }

export type RemoteMachineStage
  = | 'probe'
    | 'download'
    | 'verify'
    | 'install'
    | 'launch'
    | 'ready'
    | 'failed'
    | 'auth'
    | 'reconnect'

export type RemoteMachineTerminal = 'success' | 'failed'

export interface RemoteMachineEvent {
  seq: number
  ts: string
  machineId: MachineId
  stage: RemoteMachineStage
  line: string
  terminal?: RemoteMachineTerminal
  reason?: string
}

export interface RemoteMachineEventsPage {
  events: RemoteMachineEvent[]
  nextSeq: number
}

export interface RemoteInstallResult {
  installed: string[]
  dshRef: string
  dshVersion: string
  dshPath: string
  credentialsCopied: boolean
  credentialsError?: string
}

export type RemoteErrorCode
  = | 'machine-not-found'
    | 'machine-connect-failed'
    | 'machine-bootstrap-failed'
    | 'machine-dsh-missing'
    | 'machine-install-failed'
    | 'machine-reconnecting'
    | 'machine-sync-failed'
    | 'machine-transport-unsupported'

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

export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode, readonly machineId: MachineId, message: string) {
    super(message)
    this.name = 'RemoteError'
  }
}

export interface RemoteExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RemoteExecOptions {
  timeoutMs?: number
  onData?: (chunk: string) => void
  stdinData?: Buffer
}

export interface TunnelHeaderInjection {
  cookie: string | undefined
}

export interface RemoteStreamHandle {
  localPort: number
  close: () => Promise<void>
}

export interface RemoteSession {
  readonly authMethod?: RemoteAuthMethod | undefined
  exec: (command: string, options?: RemoteExecOptions) => Promise<RemoteExecResult>
  stream: (remotePort: number, preferredLocalPort?: number, injection?: TunnelHeaderInjection) => Promise<RemoteStreamHandle>
  onClosed: (callback: () => void) => void
  close: () => Promise<void>
}

export interface HostWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface HostWebServer {
  register: (route: HostWebRoute) => () => void
}

export interface RemoteHostContext {
  webServer: HostWebServer
  effect: (execute: () => (() => void) | void, label?: string) => unknown
  logger?: { error: (message: string) => void, warn?: (message: string) => void }
}
