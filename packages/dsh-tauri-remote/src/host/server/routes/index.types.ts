import type { RemoteAuthMethod, RemoteConnectionState, RemoteProgress } from '../../types/index'

export interface RemoteMachineListItem {
  id?: string
  name?: string
  host?: string
  port?: number
  user?: string
  hasPassword?: boolean
  hasPassphrase?: boolean
  remotePort?: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
  state?: RemoteConnectionState
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  progress?: RemoteProgress
  nextRetryAt?: number
  authMethod?: RemoteAuthMethod
}

export interface RemoteSettingsBody {
  enabled?: boolean
}

export interface RemoteSettingsResponse {
  enabled?: boolean
  error?: string
}

export interface RemoteSessionRoleResponse {
  role?: string
  remote?: boolean
  origin?: string
  error?: string
}

export interface RemoteMachinesResponse {
  enabled?: boolean
  items?: RemoteMachineListItem[]
  discovered?: RemoteMachineListItem[]
  error?: string
}

export interface SshMachineRowBody {
  name?: string
  host?: string
  port?: number
  user?: string
  remotePort?: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

export interface SshMachineSecretsBody {
  password?: string
  passphrase?: string
}

export interface SshMachineSaveBody {
  machineId?: string
  row?: SshMachineRowBody
  secrets?: SshMachineSecretsBody
}

export interface SshMachineIdBody {
  machineId?: string
}

export interface SshMachineEventsQuery {
  machineId?: string
  sinceSeq?: number
}

export interface SshMachineEventItem {
  seq?: number
  ts?: string
  machineId?: string
  stage?: string
  line?: string
  terminal?: string
  reason?: string
}

export interface SshMachineEventsResponse {
  items?: SshMachineEventItem[]
  nextSeq?: number
  error?: string
}

export interface SshTestResponse {
  ok?: boolean
  banner?: string
  message?: string
  error?: string
}

export interface SshConnectResponse {
  tunnelBaseUrl?: string
  error?: string
}

export interface SshInstallResponse {
  installed?: string[]
  dshRef?: string
  dshVersion?: string
  dshPath?: string
  credentialsCopied?: boolean
  credentialsError?: string
  error?: string
}

export interface SshActionResponse {
  error?: string
}

export interface SyncPreviewPluginItem {
  name?: string
  spec?: string
  syncable?: boolean
  reason?: string
}

export interface SyncPreviewSkillItem {
  name?: string
  root?: string
}

export interface SyncPreviewResponse {
  plugins?: SyncPreviewPluginItem[]
  skills?: SyncPreviewSkillItem[]
  error?: string
}

export interface SyncPluginRefBody {
  name?: string
  spec?: string
}

export interface SyncSkillRefBody {
  name?: string
  root?: string
}

export interface SyncApplyBody {
  machineId?: string
  plugins?: SyncPluginRefBody[]
  skills?: SyncSkillRefBody[]
}

export interface SyncApplyItemResult {
  kind?: string
  name?: string
  root?: string
  ok?: boolean
  error?: string
  log?: string
}

export interface SyncApplyResponse {
  items?: SyncApplyItemResult[]
  error?: string
}
