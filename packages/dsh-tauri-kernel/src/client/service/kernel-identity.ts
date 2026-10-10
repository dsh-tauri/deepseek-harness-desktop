import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { BackendDetection, BackendId, KernelBinding } from '../../shared/types'

export function backendFromIdentity(value: unknown): BackendId | undefined {
  if (value === null)
    return 'dsh'
  if (typeof value !== 'object')
    return undefined
  const binding = value as Partial<KernelBinding>
  return (binding.backend === 'codex' || binding.backend === 'claude')
    && typeof binding.nativeSessionId === 'string' && binding.nativeSessionId.trim() !== ''
    && typeof binding.sessionId === 'string' && binding.sessionId.trim() !== ''
    ? binding.backend
    : undefined
}

export function kernelFromList(state: SessionListState, sessionId: SessionId): KernelBinding | null | undefined {
  const projected = state.projectionsBySession?.[sessionId]?.values
  const summary = state.byId[sessionId]?.projectionValues
  return projected?.bridgeKernel !== undefined ? projected.bridgeKernel : summary?.bridgeKernel
}

export function isBackendAvailable(backend: BackendDetection | undefined): boolean {
  return backend !== undefined && backend.installed && backend.bridgeReady !== false && !backend.drift && backend.auth !== 'missing'
}

export function isForkedIdentity(value: unknown, sessionId: string | undefined): boolean {
  if (value === null || typeof value !== 'object' || backendFromIdentity(value) === undefined)
    return false
  return (value as KernelBinding).sessionId !== sessionId
}
