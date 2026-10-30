export type PresetRow = readonly [number, number, number, number]

export type PresetTable = Record<string, PresetRow>

export const PRESET_SOURCE_URL
  = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export const PRESET_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function factsOf(entry: Record<string, unknown>): PresetRow {
  return [
    entry.supports_vision === true ? 1 : 0,
    entry.supports_reasoning === true ? 1 : 0,
    positiveInteger(entry.max_input_tokens),
    positiveInteger(entry.max_output_tokens),
  ]
}

function bareKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? normalized : normalized.slice(slash + 1)
}

function unionRow(current: PresetRow | undefined, row: PresetRow): PresetRow {
  if (current === undefined)
    return row
  return [current[0] || row[0], current[1] || row[1], Math.max(current[2], row[2]), Math.max(current[3], row[3])]
}

export function buildPresetTable(payload: unknown): PresetTable {
  const merged = new Map<string, PresetRow>()
  if (payload === null || typeof payload !== 'object')
    return {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object')
      continue
    const entry = value as Record<string, unknown>
    if (entry.mode !== 'chat')
      continue
    const bare = bareKey(key)
    if (bare.length === 0 || bare === 'sample_spec')
      continue
    const row = factsOf(entry)
    if (row.every(fact => fact === 0))
      continue
    merged.set(bare, unionRow(merged.get(bare), row))
  }
  const pruned: PresetTable = {}
  for (const key of [...merged.keys()].sort((left, right) => left.length - right.length)) {
    const row = merged.get(key) as PresetRow
    const segments = key.split('-')
    let covered = false
    for (let end = segments.length - 1; end > 0 && !covered; end--) {
      const prefix = merged.get(segments.slice(0, end).join('-'))
      if (prefix !== undefined && prefix.every((fact, index) => fact === row[index]))
        covered = true
    }
    if (!covered)
      pruned[key] = row
  }
  return pruned
}
