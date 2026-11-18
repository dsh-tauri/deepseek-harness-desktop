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
  phase: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'switching' | 'reconnecting' | 'given-up'
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
  /** 正在进行的核心切换：切换期间这台机器的连接操作归切换任务独占。 */
  switchOwner?: CoreSwitchLease
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
  /** 已经在跑的自动重连尝试：切换必须等它结束，不能与它并行。 */
  attempting?: Promise<void>
  reasons: string[]
}

/** 一次核心切换的租约：机器状态一旦变化（用户断开、配置变更、插件停用），租约即失效。 */
export interface CoreSwitchLease {
  machineId: MachineId
  generation: number
}

export interface MachineDeps {
  transport: RemoteTransportResolver
  emitStatus: (machineId: MachineId, status: RemoteMachineStatus) => void
  localAllowlist: () => WorkspaceAllowlist
  bundledPluginsTree?: BundledPluginsTree
}
