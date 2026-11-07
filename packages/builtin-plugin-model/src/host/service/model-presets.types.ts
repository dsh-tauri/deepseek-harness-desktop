import type { PresetSource, PresetTable } from '../../shared/model-presets'

export interface PresetTablePayload {
  version: string
  source: PresetSource
  fetchedAt: string
  presets: PresetTable
}

export type PresetResolveResult
  = | (PresetTablePayload & { ok: true, stale: boolean })
    | { ok: false, error: string }
