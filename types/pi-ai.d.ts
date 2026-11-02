declare module '@earendil-works/pi-ai/providers/all' {
  export interface PiAiBuiltinModel {
    provider?: string
    id: string
    api?: string
    reasoning?: boolean
    thinkingLevelMap?: Record<string, string | null>
    input?: readonly string[]
    contextWindow?: number
    maxTokens?: number
  }

  export function getBuiltinProviders(): string[]
  export function getBuiltinModels(provider: string): PiAiBuiltinModel[]
}

declare module '@earendil-works/pi-ai/models' {
  import type { PiAiBuiltinModel } from '@earendil-works/pi-ai/providers/all'

  export function getSupportedThinkingLevels(model: PiAiBuiltinModel): string[]
}
