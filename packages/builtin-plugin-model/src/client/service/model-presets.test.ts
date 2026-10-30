import { beforeEach, describe, expect, it } from 'vitest'
import { PRESET_FIXTURE } from './__tests__/model-preset-fixtures'
import { presetFor, setPresetTable } from './model-presets'

const GRADED = { off: null, low: 'low', medium: 'medium', high: 'high' }
const VISION = ['text', 'image']

describe('presetFor with the downloaded table', () => {
  beforeEach(() => setPresetTable(PRESET_FIXTURE))

  it('reads vision and thinking off the table', () => {
    expect(presetFor('gpt-4o')?.input).toEqual(VISION)
    expect(presetFor('o3')?.input).toEqual(VISION)
    expect(presetFor('o3')?.efforts).toEqual(GRADED)
    expect(presetFor('deepseek-reasoner')?.efforts).toEqual(GRADED)
    expect(presetFor('mimo-v2-flash')?.efforts).toEqual(GRADED)
  })

  it('leaves a fact the table does not state undeclared instead of writing it off', () => {
    expect(presetFor('gpt-4o')).toEqual({ input: VISION, contextWindow: 128000, maxTokens: 16384 })
    expect(presetFor('deepseek-reasoner')).toEqual({
      efforts: GRADED,
      contextWindow: 131072,
      maxTokens: 65536,
    })
  })

  it('carries the table capacities', () => {
    expect(presetFor('gpt-4o')?.contextWindow).toBe(128000)
    expect(presetFor('gpt-4o')?.maxTokens).toBe(16384)
  })

  it('resolves provider prefixes', () => {
    expect(presetFor('openai/gpt-4o')?.input).toEqual(VISION)
    expect(presetFor('Qwen/Qwen3-32B')?.efforts).toEqual(GRADED)
    expect(presetFor('openrouter/moonshotai/kimi-k2-thinking')?.efforts).toEqual(GRADED)
  })

  it('resolves dated and versioned spellings through prefix fallback', () => {
    expect(presetFor('gpt-4o-2024-08-06')?.contextWindow).toBe(128000)
    expect(presetFor('claude-3-5-sonnet-20241022')?.input).toEqual(VISION)
    expect(presetFor('gemini-2.5-flash-preview-09-2025')?.efforts).toEqual(GRADED)
  })

  it('adds the family rule on top of a table that has no row', () => {
    expect(presetFor('doubao-seed-1.6')?.input).toEqual(VISION)
    expect(presetFor('doubao-seed-1.6')?.efforts).toEqual(GRADED)
    expect(presetFor('minimax-m2')?.efforts).toEqual(GRADED)
  })

  it('hands out a fresh effort map so one row cannot mutate another', () => {
    expect(presetFor('o3')?.efforts).not.toBe(presetFor('o3')?.efforts)
  })
})

describe('presetFor without the table', () => {
  beforeEach(() => setPresetTable({}))

  it('still answers for families the model name already declares', () => {
    expect(presetFor('gemini-1.5-pro')?.input).toEqual(VISION)
    expect(presetFor('claude-3-haiku')?.input).toEqual(VISION)
    expect(presetFor('glm-4v')?.input).toEqual(VISION)
    expect(presetFor('grok-2-vision')?.input).toEqual(VISION)
    expect(presetFor('glm-4.6')?.efforts).toEqual(GRADED)
    expect(presetFor('glm-z1-air')?.efforts).toEqual(GRADED)
    expect(presetFor('minimax-m1')?.efforts).toEqual(GRADED)
    expect(presetFor('gpt-5-mini')?.efforts).toEqual(GRADED)
    expect(presetFor('gpt-5-mini')?.input).toEqual(VISION)
    expect(presetFor('o3')?.efforts).toEqual(GRADED)
  })

  it('reads generic modality and thinking markers', () => {
    expect(presetFor('acme-vl-72b')?.input).toEqual(VISION)
    expect(presetFor('acme-vision-large')?.input).toEqual(VISION)
    expect(presetFor('acme-omni-mini')?.input).toEqual(VISION)
    expect(presetFor('acme-thinking-32b')?.efforts).toEqual(GRADED)
    expect(presetFor('some-qwq-32b')?.efforts).toEqual(GRADED)
  })

  it('offers no capacities of its own', () => {
    expect(presetFor('gemini-1.5-pro')?.contextWindow).toBeUndefined()
    expect(presetFor('gemini-1.5-pro')?.maxTokens).toBeUndefined()
  })

  it('leaves models it cannot place unconfigured', () => {
    expect(presetFor('glm-4-plus')).toBeUndefined()
    expect(presetFor('doubao-pro-32k')).toBeUndefined()
    expect(presetFor('abab6.5s-chat')).toBeUndefined()
    expect(presetFor('acme-inhouse-7b')).toBeUndefined()
    expect(presetFor('m')).toBeUndefined()
    expect(presetFor('   ')).toBeUndefined()
  })
})
