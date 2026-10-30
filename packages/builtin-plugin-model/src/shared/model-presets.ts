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

export const PRESET_CATALOG_VERSION = 'pi-ai-builtin-v1'
