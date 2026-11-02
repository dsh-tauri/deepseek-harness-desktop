import type { ModelCapabilityPreset, PresetTable } from '../../shared/model-presets'
import { getPresets } from '../apis'
import { modelPresets } from '../store/modules/model-presets'

export type PresetsLoad
  = | { ok: true, count: number, stale: boolean }
    | { ok: false, error: string }

let pending: Promise<PresetsLoad> | undefined

function toPresetTable(input: Record<string, unknown> | undefined): PresetTable {
  const table: PresetTable = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value !== 'object' || value === null)
      continue
    table[key] = value as ModelCapabilityPreset
  }
  return table
}

async function load(): Promise<PresetsLoad> {
  try {
    const response = await getPresets()
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    const table = toPresetTable(response.presets as Record<string, unknown> | undefined)
    const count = Object.keys(table).length
    if (count === 0)
      return { ok: false, error: 'the preset dataset carried no chat models' }
    modelPresets.setTable(table)
    return { ok: true, count, stale: response.stale === true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadPresets(): Promise<PresetsLoad> {
  if (pending !== undefined)
    return pending
  const attempt = load()
  pending = attempt
  const result = await attempt
  if (!result.ok)
    pending = undefined
  return result
}
