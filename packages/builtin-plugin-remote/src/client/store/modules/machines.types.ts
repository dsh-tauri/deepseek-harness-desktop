import type { RemoteKey } from '../../locales/index'
import type {
  InstallResult,
  MachineRow,
  MachineStatus,
  ProgressPhase,
} from '../../types/index'

export type MachinesStatus = 'idle' | 'loading' | 'ready' | 'error'

export type MachineBusyOp = 'test' | 'connect' | 'disconnect' | 'install'

export type MachinesNotice
  = | { kind: 'text', text: string }
    | { kind: 'key', key: RemoteKey, params?: Record<string, string | number> }

export interface MachinesState {
  status: MachinesStatus
  error: string | null
  enabled: boolean | null
  enabling: boolean
  machines: MachineRow[]
  discovered: MachineRow[]
  statuses: Record<string, MachineStatus>
  logs: Record<string, string[]>
  trails: Record<string, ProgressPhase[]>
  busy: Record<string, MachineBusyOp>
  notice: MachinesNotice | null
  installResults: Record<string, InstallResult>
  role: { remote: boolean, origin?: string } | null
  migrationWarning: string | null
  eventCursors: Record<string, number>
  eventsSupported: boolean
}
