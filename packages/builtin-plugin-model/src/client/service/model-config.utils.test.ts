import type { LlmDiscoveredModel } from '../types/remotes.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { PRESET_FIXTURE } from './__tests__/model-preset-fixtures'
import {
  hasModelConfig,
  mergeModelCards,
  modelConfigNotice,
  withCount,
  withDetail,
} from './model-config.utils'
import { setPresetTable } from './model-presets'

const found = (id: string, extra: Partial<LlmDiscoveredModel> = {}): LlmDiscoveredModel => ({ id, ...extra })

describe('hasModelConfig', () => {
  it('treats an identity-only row as unconfigured', () => {
    expect(hasModelConfig({ id: 'm', name: 'M', description: 'd' })).toBe(false)
  })

  it('reports every capability field as configuration', () => {
    expect(hasModelConfig({ id: 'm', contextWindow: 1024 })).toBe(true)
    expect(hasModelConfig({ id: 'm', maxTokens: 128 })).toBe(true)
    expect(hasModelConfig({ id: 'm', input: ['text'] })).toBe(true)
    expect(hasModelConfig({ id: 'm', reasoningEfforts: false })).toBe(true)
  })
})

describe('mergeModelCards', () => {
  it('fills only the fields the row leaves empty', () => {
    const merged = mergeModelCards(
      [{ id: 'm', contextWindow: 4096 }],
      [found('m', { contextWindow: 262144, maxTokens: 8192 })],
    )
    expect(merged.models).toEqual([{ id: 'm', contextWindow: 4096, maxTokens: 8192 }])
    expect(merged.applied).toBe(1)
  })

  it('never rewrites a value the user already holds when filling', () => {
    const merged = mergeModelCards([{ id: 'm', maxTokens: 512 }], [found('m', { maxTokens: 8192 })])
    expect(merged.models[0]?.maxTokens).toBe(512)
    expect(merged.applied).toBe(0)
  })

  it('rewrites the disclosed capacities when the caller asks to reconfigure', () => {
    const merged = mergeModelCards(
      [{ id: 'm', contextWindow: 4096, maxTokens: 512 }],
      [found('m', { contextWindow: 262144, maxTokens: 8192 })],
      { overwrite: true },
    )
    expect(merged.models[0]).toEqual({ id: 'm', contextWindow: 262144, maxTokens: 8192 })
    expect(merged.applied).toBe(1)
  })

  it('keeps a field the endpoint did not disclose even when overwriting', () => {
    const merged = mergeModelCards([{ id: 'm', maxTokens: 512 }], [found('m', { contextWindow: 262144 })], { overwrite: true })
    expect(merged.models[0]).toEqual({ id: 'm', maxTokens: 512, contextWindow: 262144 })
  })

  it('limits the merge to the requested targets', () => {
    const merged = mergeModelCards(
      [{ id: 'a' }, { id: 'b' }],
      [found('a', { contextWindow: 1 }), found('b', { contextWindow: 2 })],
      { targets: ['b'] },
    )
    expect(merged.models).toEqual([{ id: 'a' }, { id: 'b', contextWindow: 2 }])
    expect(merged.applied).toBe(1)
  })

  it('reports rows the endpoint did not disclose', () => {
    const merged = mergeModelCards([{ id: 'a' }, { id: 'missing' }], [found('a', { contextWindow: 1 })])
    expect(merged.undisclosed).toEqual(['missing'])
    expect(merged.models[1]).toEqual({ id: 'missing' })
  })

  it('ignores a row whose id is still blank', () => {
    const merged = mergeModelCards([{ id: '' }], [found('a', { contextWindow: 1 })])
    expect(merged.applied).toBe(0)
    expect(merged.undisclosed).toEqual([])
  })

  it('carries every listed row when no target is named', () => {
    const merged = mergeModelCards([{ id: 'a' }, { id: 'b' }], [found('a', { maxTokens: 4 })])
    expect(merged.models).toEqual([{ id: 'a', maxTokens: 4 }, { id: 'b' }])
    expect(merged.applied).toBe(1)
  })

  it('leaves a row untouched when the endpoint disclosed no capacity', () => {
    const merged = mergeModelCards([{ id: 'a' }], [found('a')])
    expect(merged.applied).toBe(0)
    expect(merged.models[0]).toEqual({ id: 'a' })
  })
})

describe('mergeModelCards with presets', () => {
  beforeEach(() => setPresetTable(PRESET_FIXTURE))

  it('adds the capability facts the endpoint cannot disclose', () => {
    const merged = mergeModelCards([{ id: 'gpt-4o' }], [found('gpt-4o', { contextWindow: 200000 })])
    expect(merged.models[0]).toEqual({
      id: 'gpt-4o',
      contextWindow: 200000,
      maxTokens: 16384,
      input: ['text', 'image'],
    })
  })

  it('prefers the endpoint capacity over the preset one', () => {
    const merged = mergeModelCards([{ id: 'gpt-4o' }], [found('gpt-4o', { contextWindow: 1 })])
    expect(merged.models[0]?.contextWindow).toBe(1)
  })

  it('falls back to the preset capacity only when the endpoint said nothing', () => {
    const merged = mergeModelCards([{ id: 'gpt-4o' }], [])
    expect(merged.models[0]).toEqual({
      id: 'gpt-4o',
      contextWindow: 128000,
      maxTokens: 16384,
      input: ['text', 'image'],
    })
    expect(merged.undisclosed).toEqual([])
  })

  it('never lets a preset capacity overwrite a value the row already holds', () => {
    const merged = mergeModelCards([{ id: 'gpt-4o', contextWindow: 4096 }], [], { overwrite: true })
    expect(merged.models[0]?.contextWindow).toBe(4096)
    expect(merged.models[0]?.input).toEqual(['text', 'image'])
  })

  it('leaves rows the preset does not know to the endpoint alone', () => {
    const merged = mergeModelCards([{ id: 'acme-inhouse-7b' }], [])
    expect(merged.applied).toBe(0)
    expect(merged.undisclosed).toEqual(['acme-inhouse-7b'])
    expect(merged.models[0]).toEqual({ id: 'acme-inhouse-7b' })
  })

  it('writes the graded levels for a reasoning model', () => {
    const merged = mergeModelCards([{ id: 'o3' }], [found('o3', { contextWindow: 200000 })])
    expect(merged.models[0]?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
  })

  it('keeps the capabilities a row already declares on a single-row fill', () => {
    const row = { id: 'gpt-4o', input: ['text'], reasoningEfforts: { off: null, low: 'low' } }
    const filled = mergeModelCards([row], [], { targets: ['gpt-4o'] }).models[0]
    expect(filled?.input).toEqual(['text'])
    expect(filled?.reasoningEfforts).toEqual({ off: null, low: 'low' })
  })

  it('replaces the declared capabilities on a reconfigure', () => {
    const row = { id: 'o3', input: ['text'], reasoningEfforts: { off: null, low: 'low' } }
    const reconfigured = mergeModelCards([row], [], { targets: ['o3'], overwrite: true }).models[0]
    expect(reconfigured?.input).toEqual(['text', 'image'])
    expect(reconfigured?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
  })

  it('never rewrites a capability the table did not state as unsupported', () => {
    const row = { id: 'gpt-4o', reasoningEfforts: { off: null, low: 'low' } }
    const reconfigured = mergeModelCards([row], [], { targets: ['gpt-4o'], overwrite: true }).models[0]
    expect(reconfigured?.reasoningEfforts).toEqual({ off: null, low: 'low' })
  })
})

describe('copy placeholders', () => {
  it('substitutes one placeholder without treating the rest as patterns', () => {
    expect(withDetail('failed: {detail}', '$&')).toBe('failed: $&')
    expect(withCount('applied to {n} models', 3)).toBe('applied to 3 models')
  })
})

describe('modelConfigNotice', () => {
  const templates = { applied: 'filled {n}', none: 'nothing', undisclosed: 'missing {n}' }

  it('reports the fill count', () => {
    expect(modelConfigNotice({ applied: 2, undisclosed: [] }, templates)).toBe('filled 2')
  })

  it('reports both halves when some rows were not disclosed', () => {
    expect(modelConfigNotice({ applied: 1, undisclosed: ['a', 'b'] }, templates)).toBe('filled 1 missing 2')
  })

  it('reports only the undisclosed half when nothing could be filled', () => {
    expect(modelConfigNotice({ applied: 0, undisclosed: ['a'] }, templates)).toBe('missing 1')
  })

  it('falls back to the empty-result copy', () => {
    expect(modelConfigNotice({ applied: 0, undisclosed: [] }, templates)).toBe('nothing')
  })
})
