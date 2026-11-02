import type { ModelCapabilityPreset, PresetTable } from '../../shared/model-presets'

function candidateKeys(id: string): string[] {
  const keys: string[] = []
  const push = (value: string): void => {
    if (value.length > 0 && !keys.includes(value))
      keys.push(value)
  }
  const normalized = id.trim().toLowerCase()
  push(normalized)
  let current = normalized
  let slash = current.indexOf('/')
  while (slash >= 0) {
    current = current.slice(slash + 1)
    if (current.length > 0)
      push(current)
    slash = current.indexOf('/')
  }
  return keys
}

export function presetFor(table: PresetTable, id: string): ModelCapabilityPreset | undefined {
  const normalized = id.trim().toLowerCase()
  if (normalized.length === 0)
    return undefined
  for (const key of candidateKeys(normalized)) {
    const hit = table[key]
    if (hit !== undefined)
      return hit
  }
  return undefined
}
