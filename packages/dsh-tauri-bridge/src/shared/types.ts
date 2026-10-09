export type BackendId = 'dsh' | 'codex' | 'claude'

export interface BackendDetection {
  id: BackendId
  installed: boolean
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

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    bridgeKernel: KernelBinding | null
  }

  interface SessionProjectionStateMap {
    bridgeKernel: KernelBinding | null
  }
}
