import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { BackendDetection } from '../../shared/types'
import { describe, expect, it } from 'vitest'
import { backendFromIdentity, isBackendAvailable, isForkedIdentity, kernelFromList } from './kernel-identity'

const SESSION = 'session-a' as SessionId
const binding = { backend: 'codex' as const, nativeSessionId: 'native-a', sessionId: 'session-a' }

function list(summary: unknown, projected?: unknown): SessionListState {
  return {
    ids: [SESSION],
    byId: { [SESSION]: { projectionValues: summary } },
    projectionsBySession: projected === undefined ? {} : { [SESSION]: { values: projected } },
    phase: 'ready',
  } as SessionListState
}

function detection(patch: Partial<BackendDetection> = {}): BackendDetection {
  return { id: 'codex', installed: true, auth: 'ok', version: '1.0', drift: false, hint: null, ...patch }
}

describe('session kernel identity', () => {
  it('missing projection is unknown rather than a DeepSeek identity', () => {
    expect(backendFromIdentity(undefined)).toBeUndefined()
    expect(backendFromIdentity(null)).toBe('dsh')
  })

  it('external identity requires a supported backend and nonempty native and owner ids', () => {
    expect(backendFromIdentity(binding)).toBe('codex')
    expect(backendFromIdentity({ backend: 'claude', nativeSessionId: 'native-b', sessionId: 'session-a' })).toBe('claude')
    for (const value of [false, 'codex', {}, { ...binding, nativeSessionId: '' }, { ...binding, nativeSessionId: null }, { ...binding, sessionId: ' ' }, { ...binding, backend: 'gpt' }])
      expect(backendFromIdentity(value)).toBeUndefined()
  })

  it('list identity uses sequenced shared projection before a cached summary', () => {
    expect(kernelFromList(list({ bridgeKernel: binding }, { bridgeKernel: null }), SESSION)).toBeNull()
    expect(kernelFromList(list({ bridgeKernel: null }, { bridgeKernel: binding }), SESSION)).toEqual({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
  })

  it('list identity retains cached whole values only when no shared key has arrived', () => {
    expect(kernelFromList(list({ bridgeKernel: binding }, {}), SESSION)).toEqual({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    expect(kernelFromList(list({}), SESSION)).toBeUndefined()
  })

  it('inherited identity reports a fork without changing the displayed backend', () => {
    expect(isForkedIdentity(binding, 'session-other')).toBe(true)
    expect(isForkedIdentity(binding, 'session-a')).toBe(false)
    expect(isForkedIdentity(null, 'session-other')).toBe(false)
    expect(isForkedIdentity(undefined, 'session-other')).toBe(false)
    expect(backendFromIdentity(binding)).toBe('codex')
  })

  it('uninstalled, incompatible, and signed-out native kernels are disabled', () => {
    expect(isBackendAvailable(undefined)).toBe(false)
    expect(isBackendAvailable(detection({ installed: false }))).toBe(false)
    expect(isBackendAvailable(detection({ bridgeReady: false }))).toBe(false)
    expect(isBackendAvailable(detection({ bridgeReady: true }))).toBe(true)
    expect(isBackendAvailable(detection({ drift: true }))).toBe(false)
    expect(isBackendAvailable(detection({ auth: 'missing' }))).toBe(false)
    expect(isBackendAvailable(detection({ auth: 'unknown' }))).toBe(true)
    expect(isBackendAvailable(detection())).toBe(true)
  })
})
