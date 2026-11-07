import { describe, expect, it } from 'vitest'
import { buildPresetTable } from './model-presets'

const PAYLOAD = {
  'openai/gpt-4o': {
    mode: 'chat',
    supports_vision: true,
    max_input_tokens: 128000,
    max_output_tokens: 16384,
  },
  'azure/gpt-4o': {
    mode: 'chat',
    supports_reasoning: true,
    max_input_tokens: 200000,
    max_output_tokens: null,
  },
  'claude-3-5-sonnet': {
    mode: 'chat',
    supports_vision: true,
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  'claude-3-5-sonnet-20241022': {
    mode: 'chat',
    supports_vision: true,
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  'text-embedding-3-large': {
    mode: 'embedding',
    max_input_tokens: 8191,
  },
  'sample_spec': {
    mode: 'chat',
    max_input_tokens: 1024,
  },
  'silent-model': {
    mode: 'chat',
  },
  'not-an-object': 42,
}

describe('buildPresetTable', () => {
  it('unions the provider prefixed rows of the same bare key', () => {
    expect(buildPresetTable(PAYLOAD)['gpt-4o']).toEqual([1, 1, 200000, 16384])
  })

  it('drops non chat, placeholder, empty and malformed entries', () => {
    const table = buildPresetTable(PAYLOAD)
    expect(table['text-embedding-3-large']).toBeUndefined()
    expect(table.sample_spec).toBeUndefined()
    expect(table['silent-model']).toBeUndefined()
    expect(Object.keys(table).filter(key => key.includes('/'))).toEqual([])
  })

  it('prunes a dated key whose facts repeat an existing prefix', () => {
    const table = buildPresetTable(PAYLOAD)
    expect(table['claude-3-5-sonnet']).toEqual([1, 0, 200000, 8192])
    expect(table['claude-3-5-sonnet-20241022']).toBeUndefined()
  })

  it('keeps a key whose only covering prefix is shorter than the client fallback', () => {
    const table = buildPresetTable({
      'o3': { mode: 'chat', supports_reasoning: true, max_input_tokens: 200000 },
      'o3-2025-01-16': { mode: 'chat', supports_reasoning: true, max_input_tokens: 200000 },
    })
    expect(table.o3).toEqual([0, 1, 200000, 0])
    expect(table['o3-2025-01-16']).toEqual([0, 1, 200000, 0])
  })

  it('returns an empty table for a payload that is not an object', () => {
    expect(buildPresetTable(undefined)).toEqual({})
    expect(buildPresetTable([])).toEqual({})
  })
})
