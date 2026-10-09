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

export interface MachineState {
  generation: number
  phase: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'reconnecting' | 'given-up'
  connecting?: Promise<RemoteLink>
  installing?: Promise<RemoteInstallResult>
  session?: RemoteSession
  tunnel?: RemoteStreamHandle
  link?: RemoteLink
  lastError?: string
  dshMissing?: boolean
  progress?: RemoteProgress
  reconnect?: ReconnectState
  preferredTunnelPort?: number
  authMethod?: RemoteAuthMethod
}

export interface ReconnectState {
  generation: number
  attempt: number
  nextRetryAt?: number
  timer?: NodeJS.Timeout
  reasons: string[]
}

export interface MachineDeps {
  transport: RemoteTransportResolver
  emitStatus: (machineId: MachineId, status: RemoteMachineStatus) => void
  localAllowlist: () => WorkspaceAllowlist
  bundledPluginsTree?: BundledPluginsTree
}
