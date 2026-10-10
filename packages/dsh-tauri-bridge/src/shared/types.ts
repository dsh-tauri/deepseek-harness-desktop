import type { NativeTurnOptions } from './native-model'

export type BackendId = 'dsh' | 'codex' | 'claude'

export interface BackendDetection {
  id: BackendId
  installed: boolean
  bridgeReady?: boolean
  auth: 'ok' | 'missing' | 'unknown'
  version: string | null
  drift: boolean
  hint: string | null
}

export interface KernelBinding {
  backend: Exclude<BackendId, 'dsh'>
  nativeSessionId: string
  sessionId: string
}

export interface KernelProjectionState {
  readonly ownerSessionId: string
  readonly inheritedEventCount: number
  readonly inheritedBinding: KernelBinding | null
  readonly binding: KernelBinding | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    bridgeModel: NativeTurnOptions
    bridgeKernel: KernelBinding | null
  }

  interface SessionProjectionStateMap {
    bridgeModel: NativeTurnOptions
    bridgeKernel: KernelProjectionState
  }
}
