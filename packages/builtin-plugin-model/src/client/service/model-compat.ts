import type { ModelCapabilityPreset } from '../../shared/model-presets'

export type ModelCompatDraft = Record<string, unknown>

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const DEFAULT_THINKING_EFFORTS: Readonly<Record<string, string | null>> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
}

export const TEMPLATE_THINKING_FORMAT = 'chat-template'
export const TEMPLATE_THINKING_KWARG = 'reasoning_effort'
export const TEMPLATE_THINKING_EFFORT_VAR = 'thinking.effort'

export const TEMPLATE_COMPAT_PROTOCOL = 'openai-completions'

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {}
  return value as Record<string, unknown>
}

function compatOf(model: ModelCompatDraft): Record<string, unknown> {
  return recordOf(model.compat)
}

export function thinkingEffortsOf(model: ModelCompatDraft): Record<string, string | null> {
  const efforts = model.reasoningEfforts
  if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts))
    return {}
  return efforts as Record<string, string | null>
}

export function declaredThinkingLevels(model: ModelCompatDraft): string[] {
  return Object.keys(thinkingEffortsOf(model))
}

export function supportsThinking(model: ModelCompatDraft): boolean {
  return Object.keys(thinkingEffortsOf(model)).some(level => level !== 'off')
}

export function isThinkingEnabled(model: ModelCompatDraft): boolean {
  return model.reasoningEfforts !== false && model.reasoningEfforts !== undefined
}

export function wireValueOf(
  level: string,
  customEfforts: Readonly<Record<string, string | null>>,
  presetEfforts: Readonly<Record<string, string | null>> | undefined,
): string | null | undefined {
  return level in customEfforts ? customEfforts[level] : presetEfforts?.[level]
}

export function enableThinking(
  model: ModelCompatDraft,
  preset: ModelCapabilityPreset | undefined,
): Record<string, string | null> {
  const current = thinkingEffortsOf(model)
  const graded = Object.keys(current).filter(level => level !== 'off')
  if (graded.length > 0)
    return current
  if (preset?.reasoningEfforts && typeof preset.reasoningEfforts === 'object')
    return { ...preset.reasoningEfforts }
  return { ...DEFAULT_THINKING_EFFORTS }
}

export function toggleThinkingLevel(
  efforts: Readonly<Record<string, string | null>>,
  level: string,
  enabled: boolean,
  wireValue?: string | null,
): Record<string, string | null> | false {
  const next = { ...efforts }
  if (enabled)
    next[level] = wireValue !== undefined ? wireValue : (level === 'off' ? null : level)
  else
    delete next[level]
  return Object.keys(next).length === 0 ? false : next
}

export function supportsTemplateThinking(model: ModelCompatDraft): boolean {
  const compat = compatOf(model)
  return compat.thinkingFormat === TEMPLATE_THINKING_FORMAT && compat.supportsDeveloperRole === false
}

export function templateThinkingCompat(
  model: ModelCompatDraft,
  next: boolean,
): Record<string, unknown> | undefined {
  const compat = { ...compatOf(model) }
  const kwargs = { ...recordOf(compat.chatTemplateKwargs) }
  delete kwargs[TEMPLATE_THINKING_KWARG]
  if (next) {
    compat.chatTemplateKwargs = { ...kwargs, [TEMPLATE_THINKING_KWARG]: { $var: TEMPLATE_THINKING_EFFORT_VAR } }
    compat.thinkingFormat = TEMPLATE_THINKING_FORMAT
    compat.supportsDeveloperRole = false
  }
  else {
    delete compat.thinkingFormat
    delete compat.supportsDeveloperRole
    if (Object.keys(kwargs).length === 0)
      delete compat.chatTemplateKwargs
    else
      compat.chatTemplateKwargs = kwargs
  }
  return Object.keys(compat).length === 0 ? undefined : compat
}
