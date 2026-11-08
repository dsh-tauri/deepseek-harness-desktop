import type { ModelCapabilityPreset, PresetTable } from '../../shared/model-presets'
import { PRESET_MIN_PREFIX_LENGTH, PRESET_REASONING_EFFORTS } from '../../shared/model-presets'

interface FamilyRule {
  pattern: RegExp
  vision?: boolean
  reasoning?: boolean
}

interface RuleFacts {
  vision: boolean
  reasoning: boolean
}

const FAMILY_RULES: readonly FamilyRule[] = [
  { pattern: /\bclaude/, vision: true },
  { pattern: /\bgemini/, vision: true },
  { pattern: /\bgrok-[2-9]/, vision: true },
  { pattern: /[-.]vl(?:-|$)|[-.]vision(?:-|$)|[-.]omni(?:-|$)/, vision: true },
  { pattern: /\bglm-[\d.]+v/, vision: true },
  { pattern: /(?:^|[/-])seed-1\.[6-9]|\bdoubao-seed|\bseed-[2-9]/, vision: true, reasoning: true },
  { pattern: /\bgpt-5/, vision: true, reasoning: true },
  { pattern: /\bglm-(?:4\.[5-9]|5|z)/, reasoning: true },
  { pattern: /[-.]thinking(?:-|$)|[-.]reasoning(?:-|$)/, reasoning: true },
  { pattern: /(?:^|[/-])(?:r1|qwq|reasoner)(?:-|$)/, reasoning: true },
  { pattern: /\bminimax-m[12]/, reasoning: true },
  { pattern: /\bqwen3/, reasoning: true },
  { pattern: /\bo[1-9](?:-|$)/, reasoning: true },
  { pattern: /\bdeepseek-(?:v[34]|think)/, reasoning: true },
]

const DEEPSEEK_ALIAS = /^(?:(.*)\/)?ds-?(\d.*)$/

const compactIndexes = new WeakMap<PresetTable, ReadonlyMap<string, ModelCapabilityPreset>>()

function aliasOf(normalized: string): string {
  const match = DEEPSEEK_ALIAS.exec(normalized)
  if (match === null)
    return normalized
  return `${match[1] === undefined ? '' : `${match[1]}/`}deepseek-v${match[2] as string}`
}

function compact(value: string): string {
  return value.replace(/[-._\s]/g, '')
}

function candidateKeys(id: string): string[] {
  const keys: string[] = []
  const push = (value: string): void => {
    if (value.length > 0 && !keys.includes(value))
      keys.push(value)
  }
  const slash = id.lastIndexOf('/')
  const bare = slash < 0 ? id : id.slice(slash + 1)
  push(id)
  push(bare)
  const segments = bare.split('-')
  for (let end = segments.length - 1; end > 0; end--) {
    const prefix = segments.slice(0, end).join('-')
    if (prefix.length < PRESET_MIN_PREFIX_LENGTH)
      break
    push(prefix)
  }
  return keys
}

function compactIndex(table: PresetTable): ReadonlyMap<string, ModelCapabilityPreset> {
  const known = compactIndexes.get(table)
  if (known !== undefined)
    return known
  const built = new Map<string, ModelCapabilityPreset>()
  for (const [key, preset] of Object.entries(table)) {
    const spelled = compact(key)
    if (spelled.length > 0 && !built.has(spelled))
      built.set(spelled, preset)
  }
  compactIndexes.set(table, built)
  return built
}

function matchingPreset(table: PresetTable, id: string): ModelCapabilityPreset | undefined {
  const keys = candidateKeys(id)
  for (const key of keys) {
    const hit = table[key]
    if (hit !== undefined)
      return hit
  }
  const index = compactIndex(table)
  for (const key of keys) {
    const hit = index.get(compact(key))
    if (hit !== undefined)
      return hit
  }
  return undefined
}

function aliasedPreset(table: PresetTable, alias: string): ModelCapabilityPreset | undefined {
  const needle = compact(alias)
  let best: ModelCapabilityPreset | undefined
  let bestKey: string | undefined
  for (const [key, preset] of compactIndex(table)) {
    if (!key.startsWith(needle))
      continue
    if (bestKey === undefined || key.length < bestKey.length || (key.length === bestKey.length && key < bestKey)) {
      best = preset
      bestKey = key
    }
  }
  return best
}

function ruleFacts(spellings: readonly string[]): RuleFacts | undefined {
  let vision = false
  let reasoning = false
  let matched = false
  for (const rule of FAMILY_RULES) {
    if (!spellings.some(spelling => rule.pattern.test(spelling)))
      continue
    matched = true
    vision = vision || rule.vision === true
    reasoning = reasoning || rule.reasoning === true
  }
  return matched ? { vision, reasoning } : undefined
}

function refusesThinking(known: ModelCapabilityPreset): boolean {
  if (known.reasoning !== false)
    return false
  const declared = known.reasoningEfforts
  if (declared === false)
    return true
  if (typeof declared !== 'object' || declared === null)
    return true
  return !Object.keys(declared).some(level => level !== 'off')
}

function combine(preset: ModelCapabilityPreset | undefined, rule: RuleFacts | undefined): ModelCapabilityPreset {
  const known = preset ?? {}
  const declared = known.reasoningEfforts
  const vision = known.input?.includes('image') === true || rule?.vision === true
  const reasoning = !refusesThinking(known) && (known.reasoning === true || rule?.reasoning === true)
  const efforts = typeof declared === 'object' && declared !== null
    ? { ...declared }
    : reasoning
      ? { ...PRESET_REASONING_EFFORTS }
      : declared === false
        ? false
        : undefined
  const input = vision ? ['text', 'image'] : known.input === undefined ? undefined : [...known.input]
  return {
    ...known.provider === undefined ? {} : { provider: known.provider },
    ...known.id === undefined ? {} : { id: known.id },
    ...known.api === undefined ? {} : { api: known.api },
    ...input === undefined ? {} : { input },
    ...reasoning ? { reasoning: true } : {},
    ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    ...known.contextWindow === undefined ? {} : { contextWindow: known.contextWindow },
    ...known.maxTokens === undefined ? {} : { maxTokens: known.maxTokens },
  }
}

export function presetFor(table: PresetTable, id: string): ModelCapabilityPreset | undefined {
  const normalized = id.trim().toLowerCase()
  if (normalized.length === 0)
    return undefined
  const alias = aliasOf(normalized)
  const row = matchingPreset(table, normalized) ?? (alias === normalized ? undefined : aliasedPreset(table, alias))
  const rule = ruleFacts(alias === normalized ? [normalized] : [normalized, alias])
  if (row === undefined && rule === undefined)
    return undefined
  return combine(row, rule)
}
