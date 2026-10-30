import type { PresetTable } from '../../shared/model-presets'
import { describe, expect, it } from 'vitest'
import { presetFor } from './model-presets'

const FIXTURE: PresetTable = {
  'gemini-3.8-flash': {
    provider: 'google',
    id: 'gemini-3.8-flash',
    api: 'google-generative-ai',
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  'gpt-4o': {
    provider: 'openai',
    id: 'gpt-4o',
    api: 'openai-completions',
    input: ['text', 'image'],
    reasoning: false,
    reasoningEfforts: false as const,
    contextWindow: 128000,
    maxTokens: 16384,
  },
}

describe('presetFor', () => {
  it('matches exact id', () => {
    expect(presetFor(FIXTURE, 'gemini-3.8-flash')?.input).toEqual(['text', 'image'])
    expect(presetFor(FIXTURE, 'gemini-3.8-flash')?.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high' })
  })

  it('matches prefixed custom id by stripping prefix', () => {
    expect(presetFor(FIXTURE, 'group/gemini-3.8-flash')?.input).toEqual(['text', 'image'])
    expect(presetFor(FIXTURE, 'group/gemini-3.8-flash')?.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high' })
    expect(presetFor(FIXTURE, 'openai/gpt-4o')?.input).toEqual(['text', 'image'])
    expect(presetFor(FIXTURE, 'openai/gpt-4o')?.reasoningEfforts).toBe(false)
  })

  it('returns undefined for unknown models and an empty table', () => {
    expect(presetFor(FIXTURE, 'some-unknown-model')).toBeUndefined()
    expect(presetFor(FIXTURE, '   ')).toBeUndefined()
    expect(presetFor({}, 'gemini-3.8-flash')).toBeUndefined()
  })
})
