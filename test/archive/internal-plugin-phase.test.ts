import type { InternalPluginsPhasePayload } from '../../src/store/modules/harness'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INTERNAL_PLUGIN_PHASE_DETAILS } from '../../src/store/modules/harness'
import { internalPluginReason } from '../../src/store/modules/harness/utils'

function translate(key: string): string {
  return key
}

function payload(detail: InternalPluginsPhasePayload['detail']): InternalPluginsPhasePayload {
  return {
    phase: 'done',
    detail,
    completed: 0,
    total: 5,
  }
}

describe('internal plugin phase contract', () => {
  it('matches every Rust detail emitted by the startup phase', () => {
    const rustSource = readFileSync(
      new URL('../src-tauri/src/service/plugin/internal/mod.rs', import.meta.url),
      'utf8',
    )
    const declaration = rustSource.match(
      /enum InternalPluginPhaseDetail \{(?<variants>[^}]+)\}/,
    )
    const rustDetails = declaration?.groups?.variants
      .match(/\b[A-Z][A-Za-z]+\b/g)
      ?.map(variant => variant.toLowerCase())

    expect(rustDetails).toEqual(INTERNAL_PLUGIN_PHASE_DETAILS)
  })

  it('replaces stale activity text for timeout and cancellation terminal events', () => {
    const stale = 'status.internal_installing'

    expect(internalPluginReason(payload('timeout'), stale, translate))
      .toBe('status.internal_timeout')
    expect(internalPluginReason(payload('cancelled'), stale, translate))
      .toBe('status.internal_cancelled')
  })

  it('retains the active reason only for heartbeat events', () => {
    expect(internalPluginReason(payload('heartbeat'), 'active install', translate))
      .toBe('active install')
    expect(internalPluginReason(payload('done'), 'active install', translate))
      .toBe('status.internal_done')
  })
})
