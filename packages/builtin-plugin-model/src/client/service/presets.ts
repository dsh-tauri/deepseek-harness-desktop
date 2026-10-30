import type { PresetRow } from '../../shared/model-presets'
import { getPresets } from '../apis'
import { setPresetTable } from './model-presets'

export type PresetsLoad
  = | { ok: true, count: number, stale: boolean }
    | { ok: false, error: string }

let pending: Promise<PresetsLoad> | undefined

function toRows(input: Record<string, readonly number[]> | undefined): Record<string, PresetRow> {
  const rows: Record<string, PresetRow> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    const [vision, reasoning, maxInput, maxOutput] = value
    if (typeof vision !== 'number' || typeof reasoning !== 'number')
      continue
    if (typeof maxInput !== 'number' || typeof maxOutput !== 'number')
      continue
    rows[key] = [vision, reasoning, maxInput, maxOutput]
  }
  return rows
}

async function load(): Promise<PresetsLoad> {
  try {
    const response = await getPresets()
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    const rows = toRows(response.presets)
    const count = Object.keys(rows).length
    if (count === 0)
      return { ok: false, error: 'the preset dataset carried no chat models' }
    setPresetTable(rows)
    return { ok: true, count, stale: response.stale === true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function ensurePresets(): Promise<PresetsLoad> {
  if (pending !== undefined)
    return pending
  const attempt = load()
  pending = attempt
  const result = await attempt
  if (!result.ok)
    pending = undefined
  return result
}
