import type { MachineProfile } from '../types/index'

export interface RemoteState {
  enabled: boolean
  machines: Record<string, MachineProfile>
}
