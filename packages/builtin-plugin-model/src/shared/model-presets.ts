export interface ModelCapabilityPreset {
  provider?: string
  id?: string
  api?: string
  input?: readonly string[]
  reasoning?: boolean
  reasoningEfforts?: Readonly<Record<string, string | null>> | false
  contextWindow?: number
  maxTokens?: number
}

export type PresetTable = Record<string, ModelCapabilityPreset>

export type PresetSource = 'pi-ai' | 'litellm' | 'merged'

export type PresetRow = readonly [number, number, number, number]

export type PresetRowTable = Record<string, PresetRow>

export const PRESET_CATALOG_VERSION = 'pi-ai+litellm-v1'

export const PRESET_SOURCE_URL
  = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export const PRESET_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 前缀回退与裁剪共用的最短键长。裁剪掉的键只能靠客户端「逐段删前缀」找回，
 * 而客户端不会用短于该长度的前缀匹配，所以更短的键必须整条留在表里。
 */
export const PRESET_MIN_PREFIX_LENGTH = 3

export const PRESET_REASONING_EFFORTS: Readonly<Record<string, string | null>> = { off: null, low: 'low', medium: 'medium', high: 'high' }

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

export function buildPresetTable(payload: unknown): PresetRowTable {
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
  const pruned: PresetRowTable = {}
  for (const key of [...merged.keys()].sort((left, right) => left.length - right.length)) {
    const row = merged.get(key) as PresetRow
    const segments = key.split('-')
    let covered = false
    for (let end = segments.length - 1; end > 0 && !covered; end--) {
      const name = segments.slice(0, end).join('-')
      if (name.length < PRESET_MIN_PREFIX_LENGTH)
        break
      const prefix = merged.get(name)
      if (prefix !== undefined && prefix.every((fact, index) => fact === row[index]))
        covered = true
    }
    if (!covered)
      pruned[key] = row
  }
  return pruned
}
