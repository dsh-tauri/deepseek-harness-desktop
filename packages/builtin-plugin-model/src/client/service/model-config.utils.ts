import type { LlmDiscoveredModel } from '../types/remotes.ts'
import { presetFor } from './model-presets.ts'

export type ModelDraft = Record<string, unknown>

const CONFIG_FIELDS = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const

export function hasModelConfig(model: ModelDraft): boolean {
  return CONFIG_FIELDS.some(field => model[field] !== undefined)
}

export interface ModelConfigMerge {
  models: ModelDraft[]
  applied: number
  undisclosed: string[]
}

export interface ModelConfigMergeOptions {
  targets?: readonly string[]
  overwrite?: boolean
}

export function mergeModelCards(
  models: readonly ModelDraft[],
  discovered: readonly LlmDiscoveredModel[],
  options: ModelConfigMergeOptions = {},
): ModelConfigMerge {
  const byId = new Map(discovered.map(model => [model.id, model]))
  const selected = options.targets === undefined ? undefined : new Set(options.targets)
  const overwrite = options.overwrite === true
  let applied = 0
  const undisclosed: string[] = []
  const next = models.map((model) => {
    const id = typeof model.id === 'string' ? model.id : ''
    if (selected !== undefined && !selected.has(id))
      return model
    const found = byId.get(id)
    const preset = presetFor(id)
    const patch: Record<string, unknown> = {}
    if (found !== undefined) {
      if (found.contextWindow !== undefined && (overwrite || model.contextWindow === undefined))
        patch.contextWindow = found.contextWindow
      if (found.maxTokens !== undefined && (overwrite || model.maxTokens === undefined))
        patch.maxTokens = found.maxTokens
    }
    if (patch.contextWindow === undefined && model.contextWindow === undefined && preset?.contextWindow !== undefined)
      patch.contextWindow = preset.contextWindow
    if (patch.maxTokens === undefined && model.maxTokens === undefined && preset?.maxTokens !== undefined)
      patch.maxTokens = preset.maxTokens
    if (preset?.input !== undefined && (overwrite || model.input === undefined))
      patch.input = [...preset.input]
    if (preset?.efforts !== undefined && (overwrite || model.reasoningEfforts === undefined))
      patch.reasoningEfforts = { ...preset.efforts }
    if (Object.keys(patch).length === 0) {
      if (found === undefined && id.length > 0)
        undisclosed.push(id)
      return model
    }
    applied += 1
    return { ...model, ...patch }
  })
  return { models: next, applied, undisclosed }
}

export function withDetail(template: string, detail: string): string {
  return template.replace('{detail}', () => detail)
}

export function withCount(template: string, count: number): string {
  return template.replace('{n}', () => String(count))
}

export function modelConfigNotice(
  merge: Pick<ModelConfigMerge, 'applied' | 'undisclosed'>,
  templates: { applied: string, none: string, undisclosed: string },
): string {
  if (merge.applied === 0 && merge.undisclosed.length === 0)
    return templates.none
  const parts: string[] = []
  if (merge.applied > 0)
    parts.push(withCount(templates.applied, merge.applied))
  if (merge.undisclosed.length > 0)
    parts.push(withCount(templates.undisclosed, merge.undisclosed.length))
  return parts.join(' ')
}
