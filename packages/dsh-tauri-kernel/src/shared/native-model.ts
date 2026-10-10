export interface NativeTurnOptions {
  model: string | null
  reasoningEffort: string | null
}

export interface NativeModelInfo {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: { id: string, name: string, description?: string }[]
    defaultEffort?: string
  }
}

export interface NativeModelCatalog {
  models: NativeModelInfo[]
  defaultModel?: string
  defaultReasoningEffort?: string
}

export interface NativeModelDirectory extends NativeModelCatalog {
  backend: 'codex' | 'claude'
  current: NativeTurnOptions
}
