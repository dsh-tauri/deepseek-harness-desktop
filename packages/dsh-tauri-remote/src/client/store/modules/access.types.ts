import type { AccessStatus } from '../../types/index'

export type AccessLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AccessViewState {
  status: AccessLoadStatus
  error: string | null
  busy: boolean
  notice: string | null
  snapshot: AccessStatus | null
}
