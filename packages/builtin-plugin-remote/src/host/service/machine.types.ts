import type {
  MachineId,
  RemoteAuthMethod,
  RemoteInstallResult,
  RemoteLink,
  RemoteMachineStatus,
  RemoteProgress,
  RemoteSession,
  RemoteStreamHandle,
} from '../types/index'
import type { WorkspaceAllowlist } from '../utils/allowlist'
import type { BundledPluginsTree } from '../utils/plugins-sync'
import type { RemoteTransportResolver } from './transport.types'

export interface MachineGatewayHandle {
  id: string
  unsubscribe: () => void
}

export interface MachineState {
  generation: number
  phase: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'reconnecting' | 'given-up'
  connecting?: Promise<RemoteLink>
  installing?: Promise<RemoteInstallResult>
  session?: RemoteSession
  tunnel?: RemoteStreamHandle
  gateway?: MachineGatewayHandle
  link?: RemoteLink
  lastError?: string
  dshMissing?: boolean
  gatewayExhausted?: boolean
  progress?: RemoteProgress
  reconnect?: ReconnectState
  preferredTunnelPort?: number
  preferredGatewayPort?: number
  authMethod?: RemoteAuthMethod
}

export interface ReconnectState {
  generation: number
  attempt: number
  nextRetryAt?: number
  timer?: NodeJS.Timeout
  /** 上一次连接（会话 / 隧道 / 网关入口）的回收：下一次拨号必须等它落地，端口才可能被原样复用。 */
  pending?: Promise<void>
  reasons: string[]
}

export interface MachineDeps {
  transport: RemoteTransportResolver
  emitStatus: (machineId: MachineId, status: RemoteMachineStatus) => void
  localAllowlist: () => WorkspaceAllowlist
  bundledPluginsTree?: BundledPluginsTree
}
