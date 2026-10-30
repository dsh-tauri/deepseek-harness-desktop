import type { PresetRow, PresetTable } from '../../shared/model-presets'

export interface ModelCapabilityPreset {
  input?: readonly string[]
  efforts?: Readonly<Record<string, string | null>>
  contextWindow?: number
  maxTokens?: number
}

interface FamilyRule {
  pattern: RegExp
  vision?: boolean
  reasoning?: boolean
}

const GRADED = { off: null, low: 'low', medium: 'medium', high: 'high' } as const

const MIN_PREFIX_LENGTH = 3

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
]

let table: PresetTable = {}

export function setPresetTable(next: PresetTable): void {
  table = next
}

function ruleFacts(id: string): { vision: boolean, reasoning: boolean } | undefined {
  let vision = false
  let reasoning = false
  let matched = false
  for (const rule of FAMILY_RULES) {
    if (!rule.pattern.test(id))
      continue
    matched = true
    vision = vision || rule.vision === true
    reasoning = reasoning || rule.reasoning === true
  }
  return matched ? { vision, reasoning } : undefined
}

function combine(row: PresetRow | undefined, rule: { vision: boolean, reasoning: boolean } | undefined): ModelCapabilityPreset {
  const vision = row?.[0] === 1 || rule?.vision === true
  const reasoning = row?.[1] === 1 || rule?.reasoning === true
  const maxInput = row?.[2] ?? 0
  const maxOutput = row?.[3] ?? 0
  return {
    ...vision ? { input: ['text', 'image'] } : {},
    ...reasoning ? { efforts: { ...GRADED } } : {},
    ...maxInput === 0 ? {} : { contextWindow: maxInput },
    ...maxOutput === 0 ? {} : { maxTokens: maxOutput },
  }
}

function candidateKeys(id: string): string[] {
  const keys: string[] = []
  const push = (value: string): void => {
    if (value.length > 0 && !keys.includes(value))
      keys.push(value)
  }
  const slash = id.lastIndexOf('/')
  const bare = slash >= 0 ? id.slice(slash + 1) : id
  push(id)
  push(bare)
  const segments = bare.split('-')
  for (let end = segments.length - 1; end > 0; end--) {
    const prefix = segments.slice(0, end).join('-')
    if (prefix.length < MIN_PREFIX_LENGTH)
      break
    push(prefix)
  }
  return keys
}

export function presetFor(id: string): ModelCapabilityPreset | undefined {
  const normalized = id.trim().toLowerCase()
  if (normalized.length === 0)
    return undefined
  let row: PresetRow | undefined
  for (const key of candidateKeys(normalized)) {
    const hit = table[key]
    if (hit !== undefined) {
      row = hit
      break
    }
  }
  const rule = ruleFacts(normalized)
  if (row === undefined && rule === undefined)
    return undefined
  return combine(row, rule)
}
