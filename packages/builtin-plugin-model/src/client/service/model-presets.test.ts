import type { PresetTable } from '../../shared/model-presets'
import { describe, expect, it } from 'vitest'
import { presetFor } from './model-presets'

const TABLE: PresetTable = {
  'glm-5.3-flash': {
    provider: 'zai',
    id: 'glm-5.3-flash',
    api: 'openai-completions',
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  'glm-5.3': {
    contextWindow: 200000,
    maxTokens: 8192,
  },
  'deepseek-v4.1': {
    input: ['text'],
    reasoning: true,
    reasoningEfforts: false,
    contextWindow: 131072,
    maxTokens: 16384,
  },
  'gpt-5': {
    input: ['text'],
    reasoning: false,
    reasoningEfforts: { off: null, high: 'xhigh' },
    contextWindow: 400000,
    maxTokens: 128000,
  },
}

const GRADED = { off: null, low: 'low', medium: 'medium', high: 'high' }

describe('presetFor exact keys', () => {
  it('matches an exact id', () => {
    expect(presetFor(TABLE, 'glm-5.3-flash')).toMatchObject({
      provider: 'zai',
      api: 'openai-completions',
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 65535,
    })
  })

  it('matches a prefixed custom id by stripping the group prefix', () => {
    expect(presetFor(TABLE, 'zai/glm-5.3-flash')?.contextWindow).toBe(1048576)
    expect(presetFor(TABLE, 'zai/glm-5.3-flash')?.maxTokens).toBe(65535)
  })

  it('matches a longer id by the longest trimmed prefix', () => {
    expect(presetFor(TABLE, 'glm-5.3-flash-preview')?.contextWindow).toBe(1048576)
    expect(presetFor(TABLE, 'glm-5.3-flash-preview')?.maxTokens).toBe(65535)
  })

  it('normalizes punctuation so a squashed spelling hits the same row', () => {
    expect(presetFor(TABLE, 'glm5.3flash')?.contextWindow).toBe(1048576)
    expect(presetFor(TABLE, 'glm5.3flash')?.reasoningEfforts).toEqual(GRADED)
  })

  it('resolves the ds alias to the deepseek key', () => {
    expect(presetFor(TABLE, 'ds4.1')?.contextWindow).toBe(131072)
    expect(presetFor(TABLE, 'ds4.1')?.maxTokens).toBe(16384)
    expect(presetFor(TABLE, 'ds4.1')?.reasoningEfforts).toEqual(GRADED)
  })

  it('returns undefined for unknown ids, blank ids and an empty table', () => {
    expect(presetFor(TABLE, 'some-unknown-model')).toBeUndefined()
    expect(presetFor(TABLE, '   ')).toBeUndefined()
    expect(presetFor({}, 'vendor-flat')).toBeUndefined()
  })
})

describe('presetFor family rules', () => {
  it('prefers the preset facts over the family rule', () => {
    const preset = presetFor(TABLE, 'gpt-5')
    expect(preset?.reasoningEfforts).toEqual({ off: null, high: 'xhigh' })
    expect(preset?.reasoning).toBe(true)
    expect(preset?.contextWindow).toBe(400000)
  })

  it('falls back to the family rules when the table carries no row', () => {
    expect(presetFor({}, 'doubao-seed-1.6')).toEqual({
      input: ['text', 'image'],
      reasoning: true,
      reasoningEfforts: GRADED,
    })
    expect(presetFor({}, 'minimax-m2')).toEqual({ reasoning: true, reasoningEfforts: GRADED })
  })

  it('keeps a declared refusal of thinking instead of inventing levels', () => {
    const table: PresetTable = { 'vendor-flat': { input: ['text'], reasoning: false, reasoningEfforts: false } }
    expect(presetFor(table, 'vendor-flat')).toEqual({ input: ['text'], reasoningEfforts: false })
  })

  it('keeps a declared refusal even when a family rule matches the id', () => {
    const table: PresetTable = { 'gpt-5-mini': { input: ['text', 'image'], reasoning: false, reasoningEfforts: false } }
    expect(presetFor(table, 'gpt-5-mini')).toEqual({ input: ['text', 'image'], reasoningEfforts: false })
  })
})
