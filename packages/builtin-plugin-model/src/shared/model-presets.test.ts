import { describe, expect, it } from 'vitest'
import { buildPresetTable } from './model-presets'

const entry = (input: Record<string, unknown>): Record<string, unknown> => ({ mode: 'chat', ...input })

describe('buildPresetTable', () => {
  it('keeps only chat models and the four documented facts', () => {
    const table = buildPresetTable({
      'gpt-4o': entry({ supports_vision: true, max_input_tokens: 128000, max_output_tokens: 16384 }),
      'bge-m3': { mode: 'embedding', max_input_tokens: 8192 },
      'dall-e-3': { mode: 'image_generation' },
    })
    expect(table).toEqual({ 'gpt-4o': [1, 0, 128000, 16384] })
  })

  it('drops entries that carry no fact at all', () => {
    expect(buildPresetTable({ 'mystery-model': entry({}) })).toEqual({})
  })

  it('ignores non-positive or non-integer capacities', () => {
    const table = buildPresetTable({
      a: entry({ supports_vision: true, max_input_tokens: 0, max_output_tokens: -1 }),
      b: entry({ supports_reasoning: true, max_input_tokens: 1.5, max_output_tokens: '8192' }),
    })
    expect(table).toEqual({ a: [1, 0, 0, 0], b: [0, 1, 0, 0] })
  })

  it('unions the same model across providers', () => {
    const table = buildPresetTable({
      'openai/gpt-4o': entry({ supports_vision: true, max_input_tokens: 128000 }),
      'azure/gpt-4o': entry({ supports_reasoning: true, max_output_tokens: 16384 }),
      'openrouter/openai/gpt-4o': entry({ max_input_tokens: 200000 }),
    })
    expect(table).toEqual({ 'gpt-4o': [1, 1, 200000, 16384] })
  })

  it('keys rows by the last path segment, lower-cased', () => {
    expect(buildPresetTable({ 'Bedrock/MoonshotAI.Kimi-K2': entry({ supports_reasoning: true }) }))
      .toEqual({ 'moonshotai.kimi-k2': [0, 1, 0, 0] })
  })

  it('prunes dated variants whose facts a shorter prefix already states', () => {
    const table = buildPresetTable({
      'gpt-4o': entry({ supports_vision: true, max_input_tokens: 128000 }),
      'gpt-4o-2024-08-06': entry({ supports_vision: true, max_input_tokens: 128000 }),
    })
    expect(Object.keys(table)).toEqual(['gpt-4o'])
  })

  it('keeps a variant that states something the shorter prefix does not', () => {
    const table = buildPresetTable({
      'o3': entry({ supports_reasoning: true }),
      'o3-mini': entry({ supports_reasoning: true, max_output_tokens: 65536 }),
    })
    expect(Object.keys(table).sort()).toEqual(['o3', 'o3-mini'])
  })

  it('rejects a payload that is not an object map', () => {
    expect(buildPresetTable(undefined)).toEqual({})
    expect(buildPresetTable('nope')).toEqual({})
    expect(buildPresetTable({ sample: null })).toEqual({})
  })
})
