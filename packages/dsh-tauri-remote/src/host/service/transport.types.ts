import type { Buffer } from 'node:buffer'
import type { MachineProfile, RemoteSession } from '../types/index'
import type { ResolvedSshAuth } from '../utils/ssh-config'

export type RemoteCredentialsResolver = (profile: MachineProfile) => Promise<ResolvedSshAuth>

export interface RemoteTransportOptions {
  readyTimeoutMs: number
  resolveProfile: RemoteCredentialsResolver
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
}

export type RemoteHostKeyVerifier = (label: string, hostKey: Buffer) => boolean | Promise<boolean>

/** transport 的能力声明：状态机据此分支，不按实现名分支。 */
export interface RemoteTransportCapabilities {
  exec: boolean
  stream: boolean
}

export interface RemoteTransport {
  capabilities: RemoteTransportCapabilities
  connect: (
    profile: MachineProfile,
    hostKeyVerifier: RemoteHostKeyVerifier,
    options: RemoteTransportOptions,
    signal?: AbortSignal,
  ) => Promise<RemoteSession>
}

/** 按档案的 `transport` 判别字段选出实现的注册表；状态机只依赖本接口。 */
export interface RemoteTransportResolver {
  resolve: (profile: MachineProfile) => RemoteTransport
}

export type RemoteConnectFailureKind
  = | 'key-rejected'
    | 'password-rejected'
    | 'unreachable'
    | 'other'
