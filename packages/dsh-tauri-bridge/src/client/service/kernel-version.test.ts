import type { BackendDetection } from '../../shared/types'
import { describe, expect, it } from 'vitest'
import { kernelContentAvailable, kernelVersionAtLeast } from './kernel-version'

const dsh = (version: string | null): BackendDetection => ({ id: 'dsh', installed: true, auth: 'ok', version, drift: false, hint: null })
const codex = (patch: Partial<BackendDetection> = {}): BackendDetection => ({ id: 'codex', installed: true, auth: 'ok', version: '0.162.0', drift: false, hint: null, ...patch })

describe('kernel core version gate', () => {
  it.each([
    ['0.2.0', false],
    ['0.2.1-alpha.1', false],
    ['0.2.1-alpha.2', true],
    ['0.2.1-alpha.2+build.7', true],
    ['0.2.1-alpha.10', true],
    ['0.2.1-beta.1', true],
    ['0.2.1', true],
    ['0.2.2-alpha.1', true],
    ['0.3.0-alpha.1', true],
    ['1.0.0', true],
  ])('compares %s against the pinned baseline', (version, expected) => {
    expect(kernelVersionAtLeast(version)).toBe(expected)
  })

  it.each([null, undefined, '', 'dev', '0.2', 'v0.2.1-alpha.2'])('reports an unprovable version %s instead of guessing', (version) => {
    expect(kernelVersionAtLeast(version)).toBeUndefined()
  })

  it('uses the reported runtime version before any capability fallback', () => {
    expect(kernelContentAvailable([dsh('0.2.1-alpha.1'), codex({ bridgeReady: true })])).toBe(false)
    expect(kernelContentAvailable([dsh('0.2.1-alpha.2'), codex({ bridgeReady: false })])).toBe(true)
  })

  it('falls back to the capability probe only when the runtime version is unreadable', () => {
    expect(kernelContentAvailable([dsh(null), codex({ bridgeReady: true })])).toBe(true)
    expect(kernelContentAvailable([dsh(null), codex({ bridgeReady: false })])).toBe(false)
    expect(kernelContentAvailable([dsh(null)])).toBe(false)
    expect(kernelContentAvailable([])).toBe(false)
  })
})
