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

/** 网关来源分类：`tunnel` 只由隧道入口声明，永远按公网待遇（S2 §7.1）。 */
export type RemoteSourceClass = 'loopback' | 'private' | 'public' | 'tunnel'

/** 来源门禁三值：放行 / 需认证 / 拒绝（S2 §7.2 判定矩阵）。 */
export type RemoteAccessDecision = 'allow' | 'authenticate' | 'deny'

export type RemoteAuthScope = 'public_only' | 'all'

/** 访问密码的落盘形态；`salt` 与 `hash` 均为 base64（S2 §7.4）。 */
export interface RemotePasswordRecord {
  algo: 'pbkdf2-sha256'
  salt: string
  iterations: number
  hash: string
}

/** 认证要素快照：由持久化配置推导，每次请求重新读取，使配置变更即时生效。 */
export interface RemoteAuthPolicy {
  enabled: boolean
  scope: RemoteAuthScope
  password: RemotePasswordRecord | null
  linkToken: string | null
  sessionSecret: string
}

export interface RemoteAuthFailureRecord {
  failures: number
  bannedUntil: number
}

export interface RemoteSessionTicket {
  value: string
  /** 签发时间（S2 §7.4「含签发与过期时间」）；与过期时间一同被签名覆盖。 */
  issuedAt: number
  expiresAt: number
}

export type RemoteGatewayEntryKind = 'inbound' | 'tunnel' | 'outbound'

export type RemoteGatewayEntryState = 'listening' | 'stopped'

export interface RemoteGatewayEntryStatus {
  id: string
  kind: RemoteGatewayEntryKind
  state: RemoteGatewayEntryState
  host: string
  /** 真实监听到的端口；已停止时为 0。 */
  port: number
  url: string
  upstream: string
  connections: number
}

export type RemoteGatewayEventKind = 'listening' | 'stopped' | 'port' | 'upstream' | 'cookie' | 'compression' | 'auth'

export interface RemoteGatewayEvent {
  seq: number
  ts: string
  id: string
  kind: RemoteGatewayEventKind
  line: string
}

/**
 * cookie 铸造的 token 提供方：每次铸造重新取用（不是一次性快照），入参为转发时使用的上游
 * authority，返回一次性铸造 URL（附启动 token）；返回 undefined 表示本次铸造放弃。
 */
export type RemoteGatewayTokenProvider = (authority: string) => Promise<string | undefined>

export interface RemoteGatewayStartOptions {
  id: string
  kind: RemoteGatewayEntryKind
  /** 上游基址：`http://127.0.0.1:<port>`。 */
  upstream: string
  /** 首选端口；被占用时按 +1 试探。 */
  port: number
  /** 监听地址；缺省 `127.0.0.1`，入站按选定网卡或 `0.0.0.0`。 */
  host?: string
  tokenProvider?: RemoteGatewayTokenProvider
  auth?: () => RemoteAuthPolicy
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
