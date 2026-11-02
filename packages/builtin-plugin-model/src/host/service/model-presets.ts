import type { PiAiBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelCapabilityPreset, PresetTable } from '../../shared/model-presets'
import { defineService } from 'dsh-tauri'
import { PRESET_CATALOG_VERSION } from '../../shared/model-presets'

export interface PresetTablePayload {
  source: string
  fetchedAt: string
  presets: PresetTable
}

export type PresetResolveResult
  = | (PresetTablePayload & { ok: true, stale: boolean })
    | { ok: false, error: string }

const EXTENDED_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type PiAiModel = PiAiBuiltinModel

interface PiAiModule {
  getBuiltinProviders: () => string[]
  getBuiltinModels: (provider: string) => PiAiModel[]
  getSupportedThinkingLevels?: (model: PiAiModel) => string[]
}

async function resolvePiAiModule(): Promise<PiAiModule | undefined> {
  try {
    const all = await import('@earendil-works/pi-ai/providers/all')
    let getSupportedThinkingLevels: ((model: PiAiModel) => string[]) | undefined
    try {
      const models = await import('@earendil-works/pi-ai/models')
      getSupportedThinkingLevels = models.getSupportedThinkingLevels
    }
    catch {
    }
    return {
      getBuiltinProviders: all.getBuiltinProviders,
      getBuiltinModels: all.getBuiltinModels,
      getSupportedThinkingLevels,
    }
  }
  catch {
    return undefined
  }
}

function getLevels(model: PiAiModel, helper?: (m: PiAiModel) => string[]): string[] {
  if (helper !== undefined)
    return helper(model)
  if (!model.reasoning)
    return ['off']
  return EXTENDED_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null)
      return false
    if (level === 'xhigh' || level === 'max')
      return mapped !== undefined
    return true
  })
}

function normalizeEfforts(model: PiAiModel, helper?: (m: PiAiModel) => string[]): Record<string, string | null> | false {
  if (model.reasoning !== true)
    return false
  const levels = getLevels(model, helper)
  const efforts: Record<string, string | null> = {}
  for (const level of levels) {
    if (level === 'off')
      efforts.off = model.thinkingLevelMap?.off ?? null
    else
      efforts[level] = model.thinkingLevelMap?.[level] ?? level
  }
  return Object.keys(efforts).length === 0 ? false : efforts
}

function buildTableFromPiAi(piAi: PiAiModule): PresetTable {
  const table: PresetTable = {}
  const bareCandidates = new Map<string, { preset: ModelCapabilityPreset, conflict: boolean }>()

  for (const provider of piAi.getBuiltinProviders()) {
    for (const model of piAi.getBuiltinModels(provider)) {
      const preset: ModelCapabilityPreset = {
        provider: model.provider ?? provider,
        id: model.id,
        api: model.api,
        input: model.input !== undefined && model.input.length > 0 ? [...model.input] : ['text'],
        reasoning: model.reasoning === true,
        reasoningEfforts: normalizeEfforts(model, piAi.getSupportedThinkingLevels),
        ...model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {},
        ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
      }
      const rawId = model.id.toLowerCase()
      const withProvider = `${provider.toLowerCase()}/${rawId}`
      table[withProvider] = preset

      const slash = rawId.lastIndexOf('/')
      const bare = slash >= 0 ? rawId.slice(slash + 1) : rawId
      const existing = bareCandidates.get(bare)
      if (existing === undefined) {
        bareCandidates.set(bare, { preset, conflict: false })
      }
      else if (existing.preset.provider !== preset.provider || existing.preset.id !== preset.id) {
        existing.conflict = true
      }
    }
  }

  for (const [bare, entry] of bareCandidates.entries()) {
    if (!entry.conflict)
      table[bare] = entry.preset
  }

  return table
}

let cached: PresetTablePayload | undefined

export const modelPresets = defineService({
  async resolve(_force = false): Promise<PresetResolveResult> {
    if (cached !== undefined)
      return { ok: true, ...cached, stale: false }
    const piAi = await resolvePiAiModule()
    if (piAi === undefined)
      return { ok: false, error: 'could not resolve pi-ai builtin models' }
    const presets = buildTableFromPiAi(piAi)
    cached = {
      source: PRESET_CATALOG_VERSION,
      fetchedAt: new Date().toISOString(),
      presets,
    }
    return { ok: true, ...cached, stale: false }
  },
})
