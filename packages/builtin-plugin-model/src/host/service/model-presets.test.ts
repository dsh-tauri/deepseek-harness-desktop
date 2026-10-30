import { describe, expect, it, vi } from 'vitest'

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinProviders: () => ['google', 'other'],
  getBuiltinModels: (provider: string) => {
    if (provider === 'google') {
      return [
        {
          provider: 'google',
          id: 'gemini-3.8-flash',
          api: 'google-generative-ai',
          input: ['text', 'image'],
          reasoning: true,
          thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', off: null },
          contextWindow: 1048576,
          maxTokens: 65536,
        },
        {
          provider: 'google',
          id: 'shared-name',
          api: 'google-generative-ai',
          input: ['text'],
          reasoning: false,
        },
      ]
    }
    return [
      {
        provider: 'other',
        id: 'shared-name',
        api: 'other-api',
        input: ['text', 'image'],
        reasoning: true,
      },
    ]
  },
}))

vi.mock('@earendil-works/pi-ai/models', () => ({
  getSupportedThinkingLevels: (model: any) => {
    if (!model.reasoning)
      return ['off']
    return ['low', 'medium', 'high']
  },
}))

describe('modelPresets.resolve', () => {
  it('resolves builtin model presets and excludes ambiguous bare names', async () => {
    const { modelPresets } = await import('./model-presets')
    const result = await modelPresets.resolve()
    if (!result.ok)
      throw new Error(result.error)
    expect(result.stale).toBe(false)
    expect(result.source).toBe('pi-ai-builtin-v1')
    expect(typeof result.presets).toBe('object')

    const gemini = result.presets['gemini-3.8-flash']
    expect(gemini).toBeDefined()
    expect(gemini?.input).toEqual(['text', 'image'])
    expect(gemini?.reasoning).toBe(true)
    expect(gemini?.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high' })

    expect(result.presets['shared-name']).toBeUndefined()
    expect(result.presets['google/shared-name']).toBeDefined()
    expect(result.presets['other/shared-name']).toBeDefined()
  })
})
