export interface GetApiTauriRemoteSettingsResponse { enabled?: false | true, error?: string }
export interface PostApiTauriRemoteSettingsResponse { enabled?: false | true, error?: string }
export interface GetApiTauriRemoteSessionRoleResponse { role?: string, remote?: false | true, origin?: string, error?: string }
export interface GetApiTauriRemoteMachinesResponse {
  enabled?: false | true
  items?: { id?: string, name?: string, host?: string, port?: number, user?: string, hasPassword?: false | true, hasPassphrase?: false | true, remotePort?: number, profileName?: string, startCommand?: string, color?: string, tintBorder?: false | true, state?: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'reconnecting' | 'given-up', tunnelBaseUrl?: string, lastError?: string, dshMissing?: false | true, progress?: { phase: 'handshake' | 'starting' | 'probing' | 'installing' | 'syncing', attempt?: number, total?: number, item?: string, log?: string }, nextRetryAt?: number, authMethod?: 'agent' | 'key' | 'password' }[]
  discovered?: { id?: string, name?: string, host?: string, port?: number, user?: string, hasPassword?: false | true, hasPassphrase?: false | true, remotePort?: number, profileName?: string, startCommand?: string, color?: string, tintBorder?: false | true, state?: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'reconnecting' | 'given-up', tunnelBaseUrl?: string, lastError?: string, dshMissing?: false | true, progress?: { phase: 'handshake' | 'starting' | 'probing' | 'installing' | 'syncing', attempt?: number, total?: number, item?: string, log?: string }, nextRetryAt?: number, authMethod?: 'agent' | 'key' | 'password' }[]
  error?: string
}
export interface PostApiTauriRemoteMachinesResponse { error?: string }
export interface DeleteApiTauriRemoteMachinesResponse { error?: string }
export interface PostApiTauriRemoteMachinesTestResponse { ok?: false | true, banner?: string, message?: string, error?: string }
export interface PostApiTauriRemoteMachinesConnectResponse { tunnelBaseUrl?: string, error?: string }
export interface PostApiTauriRemoteMachinesDisconnectResponse { error?: string }
export interface PostApiTauriRemoteMachinesInstallResponse { installed?: string[], dshRef?: string, dshVersion?: string, dshPath?: string, credentialsCopied?: false | true, credentialsError?: string, error?: string }
export interface PostApiTauriRemoteMachinesRestartResponse { error?: string }
export interface GetApiTauriRemoteMachinesEventsResponse { items?: { seq?: number, ts?: string, machineId?: string, stage?: string, line?: string, terminal?: string, reason?: string }[], nextSeq?: number, error?: string }
export type GetApiTauriRemoteMachinesEventsQueryMachineId = string
export type GetApiTauriRemoteMachinesEventsQuerySinceSeq = number
export interface GetApiTauriRemoteCoreCurrentResponse {
  item?:
    | ({ id: string, scope: 'remote' | 'local', machineId?: string, remoteProfile?: string, capabilities: ('listVersions' | 'installVersion' | 'activate' | 'removeSlot' | 'asar' | 'bundledCore')[], platforms: ('windows-x64' | 'windows-arm64' | 'macos-x64' | 'macos-arm64' | 'linux-x64' | 'linux-arm64')[] } & { availability: 'absent', slots: [] })
    | ({ id: string, scope: 'remote' | 'local', machineId?: string, remoteProfile?: string, capabilities: ('listVersions' | 'installVersion' | 'activate' | 'removeSlot' | 'asar' | 'bundledCore')[], platforms: ('windows-x64' | 'windows-arm64' | 'macos-x64' | 'macos-arm64' | 'linux-x64' | 'linux-arm64')[] } & { availability: 'present', slots: ({ kind: 'installed', slotKey: string, version: string, tag?: string, path?: string, dir?: string, active: false | true, removable?: false | true, preview: false | true, bundled?: false | true, orphaned?: false | true } | { kind: 'unsupported', slotKey: string, version: string, tag?: string, path?: string, dir?: string, error: string } | { kind: 'unreadable', slotKey: string, tag?: string, path?: string, dir?: string, error: string })[] })
    | ({ id: string, scope: 'remote' | 'local', machineId?: string, remoteProfile?: string, capabilities: ('listVersions' | 'installVersion' | 'activate' | 'removeSlot' | 'asar' | 'bundledCore')[], platforms: ('windows-x64' | 'windows-arm64' | 'macos-x64' | 'macos-arm64' | 'linux-x64' | 'linux-arm64')[] } & { availability: 'unreadable', error: string, path?: string, slots: { kind: 'unreadable', slotKey: string, tag?: string, path?: string, dir?: string, error: string }[] })
  error?: string
}
export type GetApiTauriRemoteCoreCurrentQueryMachineId = string
export interface GetApiTauriRemoteCoreInstanceResponse { item?: { verdict: 'match' | 'mismatch' | 'unknown', actual?: string, expected: string, port: number, pid?: string, createdByDesktop?: false | true, clientCount?: number }, error?: string }
export type GetApiTauriRemoteCoreInstanceQueryMachineId = string
export interface GetApiTauriRemoteCoreProfilesResponse { items?: { name: string, configured: false | true }[], error?: string }
export type GetApiTauriRemoteCoreProfilesQueryMachineId = string
export interface GetApiTauriRemoteCoreVersionsResponse { items?: { version: string, tag: string, preview: false | true }[], error?: string }
export interface PostApiTauriRemoteCoreInstallResponse { taskId?: string, error?: string }
export interface GetApiTauriRemoteCoreTasksEventsResponse { items?: { taskId: string, seq: number, ts: string, state: 'failed' | 'running' | 'queued' | 'succeeded' | 'cancelled', stage: string, line: string, terminal?: 'failed' | 'success', reason?: string }[], nextSeq?: number, error?: string }
export type GetApiTauriRemoteCoreTasksEventsQueryTaskId = string
export type GetApiTauriRemoteCoreTasksEventsQuerySinceSeq = string | number
export interface GetApiTauriRemoteSyncPreviewResponse { plugins?: { name?: string, spec?: string, syncable?: false | true, reason?: string }[], skills?: { name?: string, root?: string }[], error?: string }
export interface PostApiTauriRemoteSyncApplyResponse { items?: { kind?: string, name?: string, root?: string, ok?: false | true, error?: string, log?: string }[], error?: string }
export interface GetApiTauriRemoteAccessResponse {
  version: number
  enabled: false | true
  state: 'error' | 'stopped' | 'listening'
  listening: false | true
  listen: { address: string, port: number }
  port: number
  auth: { enabled: false | true, scope: 'all' | 'public_only', hasToken?: false | true, token?: string }
  addresses: { address: string, family: 'ipv4' | 'ipv6', interface: string, scope: 'public' | 'private' | 'loopback' | 'link-local', score: number, recommended: false | true }[]
  recommended?: string
  link?: string
  maskLink?: string
  qr?: string
  linkSource?: 'loopback' | 'lan'
  pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string, tunnelLink?: string, tunnelQr?: string }
  tunnel?: { state: 'error' | 'starting' | 'stopped' | 'running', events: { seq: number, ts: string, kind: 'state' | 'process' | 'progress', line: string }[], token?: string, url?: string, port?: number, link?: string, qr?: string, progress?: { stage: 'ready' | 'spawn' | 'download' | 'verify' | 'check' | 'extract' | 'domain', url?: string, received?: number, total?: number }, error?: string, mode: 'quick' | 'token', enabled: false | true, hostname: null | string }
  localPort?: number
  error?: string
  warnings?: string[]
  events: { seq: number, ts: string, kind: 'auth' | 'token' | 'state', line: string }[]
}
export type GetApiTauriRemoteAccessQuerySincePairingUseSeq = number
export type PostApiTauriRemoteAccessResponse
  = | {
    version: number
    enabled: false | true
    state: 'error' | 'stopped' | 'listening'
    listening: false | true
    listen: { address: string, port: number }
    port: number
    auth: { enabled: false | true, scope: 'all' | 'public_only', hasToken?: false | true, token?: string }
    addresses: { address: string, family: 'ipv4' | 'ipv6', interface: string, scope: 'public' | 'private' | 'loopback' | 'link-local', score: number, recommended: false | true }[]
    recommended?: string
    link?: string
    maskLink?: string
    qr?: string
    linkSource?: 'loopback' | 'lan'
    pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string, tunnelLink?: string, tunnelQr?: string }
    tunnel?: { state: 'error' | 'starting' | 'stopped' | 'running', events: { seq: number, ts: string, kind: 'state' | 'process' | 'progress', line: string }[], token?: string, url?: string, port?: number, link?: string, qr?: string, progress?: { stage: 'ready' | 'spawn' | 'download' | 'verify' | 'check' | 'extract' | 'domain', url?: string, received?: number, total?: number }, error?: string, mode: 'quick' | 'token', enabled: false | true, hostname: null | string }
    localPort?: number
    error?: string
    warnings?: string[]
    events: { seq: number, ts: string, kind: 'auth' | 'token' | 'state', line: string }[]
  }
  | { error: string }
export type PostApiTauriRemoteAccessTunnelResponse
  = | {
    version: number
    enabled: false | true
    state: 'error' | 'stopped' | 'listening'
    listening: false | true
    listen: { address: string, port: number }
    port: number
    auth: { enabled: false | true, scope: 'all' | 'public_only', hasToken?: false | true, token?: string }
    addresses: { address: string, family: 'ipv4' | 'ipv6', interface: string, scope: 'public' | 'private' | 'loopback' | 'link-local', score: number, recommended: false | true }[]
    recommended?: string
    link?: string
    maskLink?: string
    qr?: string
    linkSource?: 'loopback' | 'lan'
    pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string, tunnelLink?: string, tunnelQr?: string }
    tunnel?: { state: 'error' | 'starting' | 'stopped' | 'running', events: { seq: number, ts: string, kind: 'state' | 'process' | 'progress', line: string }[], token?: string, url?: string, port?: number, link?: string, qr?: string, progress?: { stage: 'ready' | 'spawn' | 'download' | 'verify' | 'check' | 'extract' | 'domain', url?: string, received?: number, total?: number }, error?: string, mode: 'quick' | 'token', enabled: false | true, hostname: null | string }
    localPort?: number
    error?: string
    warnings?: string[]
    events: { seq: number, ts: string, kind: 'auth' | 'token' | 'state', line: string }[]
  }
  | { error: string }
export type DeleteApiTauriRemoteAccessTunnelResponse
  = | {
    version: number
    enabled: false | true
    state: 'error' | 'stopped' | 'listening'
    listening: false | true
    listen: { address: string, port: number }
    port: number
    auth: { enabled: false | true, scope: 'all' | 'public_only', hasToken?: false | true, token?: string }
    addresses: { address: string, family: 'ipv4' | 'ipv6', interface: string, scope: 'public' | 'private' | 'loopback' | 'link-local', score: number, recommended: false | true }[]
    recommended?: string
    link?: string
    maskLink?: string
    qr?: string
    linkSource?: 'loopback' | 'lan'
    pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string, tunnelLink?: string, tunnelQr?: string }
    tunnel?: { state: 'error' | 'starting' | 'stopped' | 'running', events: { seq: number, ts: string, kind: 'state' | 'process' | 'progress', line: string }[], token?: string, url?: string, port?: number, link?: string, qr?: string, progress?: { stage: 'ready' | 'spawn' | 'download' | 'verify' | 'check' | 'extract' | 'domain', url?: string, received?: number, total?: number }, error?: string, mode: 'quick' | 'token', enabled: false | true, hostname: null | string }
    localPort?: number
    error?: string
    warnings?: string[]
    events: { seq: number, ts: string, kind: 'auth' | 'token' | 'state', line: string }[]
  }
  | { error: string }

export interface PostApiTauriRemoteSettingsBody {
  enabled?: false | true
}
export interface PostApiTauriRemoteMachinesBody {
  machineId?: string
  row?: { name?: string, host?: string, port?: number, user?: string, remotePort?: number, profileName?: string, startCommand?: string, color?: string, tintBorder?: false | true }
  secrets?: { password?: string, passphrase?: string }
}
export interface DeleteApiTauriRemoteMachinesBody {
  machineId?: string
}
export interface PostApiTauriRemoteMachinesTestBody {
  machineId?: string
}
export interface PostApiTauriRemoteMachinesConnectBody {
  machineId?: string
}
export interface PostApiTauriRemoteMachinesDisconnectBody {
  machineId?: string
}
export interface PostApiTauriRemoteMachinesInstallBody {
  machineId?: string
  reinstall?: false | true
  ackProfileMismatch?: false | true
}
export interface PostApiTauriRemoteMachinesRestartBody {
  machineId?: string
}
export interface PostApiTauriRemoteCoreInstallBody {
  machineId?: string
  tag?: string
  force?: false | true
}
export interface PostApiTauriRemoteSyncApplyBody {
  machineId?: string
  plugins?: { name?: string, spec?: string }[]
  skills?: { name?: string, root?: string }[]
}
export interface PostApiTauriRemoteAccessBody {
  enabled?: false | true
  address?: string
  port?: number
  authEnabled?: false | true
  scope?: 'all' | 'public_only'
}
export interface PostApiTauriRemoteAccessTunnelBody {
  mode?: 'quick' | 'token'
  token?: string
  hostname?: string
}
export interface GetApiTauriRemoteMachinesEventsQuery {
  machineId?: GetApiTauriRemoteMachinesEventsQueryMachineId
  sinceSeq?: GetApiTauriRemoteMachinesEventsQuerySinceSeq
}
export interface GetApiTauriRemoteCoreCurrentQuery {
  machineId: GetApiTauriRemoteCoreCurrentQueryMachineId
}
export interface GetApiTauriRemoteCoreInstanceQuery {
  machineId: GetApiTauriRemoteCoreInstanceQueryMachineId
}
export interface GetApiTauriRemoteCoreProfilesQuery {
  machineId: GetApiTauriRemoteCoreProfilesQueryMachineId
}
export interface GetApiTauriRemoteCoreTasksEventsQuery {
  taskId?: GetApiTauriRemoteCoreTasksEventsQueryTaskId
  sinceSeq?: GetApiTauriRemoteCoreTasksEventsQuerySinceSeq
}
export interface GetApiTauriRemoteAccessQuery {
  sincePairingUseSeq?: GetApiTauriRemoteAccessQuerySincePairingUseSeq
}
