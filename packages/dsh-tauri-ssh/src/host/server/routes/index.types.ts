import type { SshAuthMethod, SshConnectionState, SshProgress } from '../../types/index'

export interface SshMachineListItem {
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
  state?: SshConnectionState
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  progress?: SshProgress
  nextRetryAt?: number
  authMethod?: SshAuthMethod
}

export interface SshSettingsBody {
  enabled?: boolean
}

export interface SshSettingsResponse {
  enabled?: boolean
  error?: string
}

export interface SshSessionRoleResponse {
  role?: string
  remote?: boolean
  origin?: string
  error?: string
}

export interface SshMachinesResponse {
  enabled?: boolean
  items?: SshMachineListItem[]
  discovered?: SshMachineListItem[]
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
