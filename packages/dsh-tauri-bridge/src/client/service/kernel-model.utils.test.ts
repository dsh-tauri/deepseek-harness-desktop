import type { NativeModelDirectory } from '../../shared/native-model'
import { describe, expect, it } from 'vitest'
import { isNativeTurnOptions, nativeModelDirectory, nativeModelOptions } from './kernel-model.utils'

const CATALOG: NativeModelDirectory = {
  backend: 'codex',
  defaultModel: 'gpt-5.4',
  current: { model: 'gpt-5.4', reasoningEffort: 'high' },
  models: [
    { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  ],
}

describe('native model directory view', () => {
  it.each([null, 'deepseek'])('one exact default model row represents durable model=$0 without a second alias', (model) => {
    const current = { model, reasoningEffort: null }
    const directory = nativeModelDirectory('codex', current, {
      backend: 'codex',
      current: { model: null, reasoningEffort: null },
      defaultModel: 'deepseek',
      models: [{ id: 'deepseek', name: 'DeepSeek' }],
    })
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'deepseek' })
    expect(directory.groups).toEqual([{ id: 'bridge/codex', name: 'Codex', models: [{ id: 'deepseek', name: 'DeepSeek' }] }])
    expect(current).toEqual({ model, reasoningEffort: null })
  })

  it('a configured native model absent from the advertised directory appears once with its exact id', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, { ...CATALOG, defaultModel: 'custom-provider/deepseek' })
    expect(directory.groups[0]?.models).toEqual([
      { id: 'custom-provider/deepseek', name: 'custom-provider/deepseek' },
      { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ])
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'custom-provider/deepseek' })
  })

  it('an unread native default has one explicit default placeholder instead of treating the bridge route as a model', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, null)
    expect(directory.groups).toEqual([{ id: 'bridge/codex', name: 'Codex', models: [{ id: '', name: 'Native default' }] }])
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: '' })
    expect(directory.routable).toBeNull()
  })

  it('shows the effective native default effort read-only even when it differs from the advertised preset', () => {
    const catalog: NativeModelDirectory = { ...CATALOG, defaultReasoningEffort: 'high' }
    const current = { model: null, reasoningEffort: null }
    const directory = nativeModelDirectory('codex', current, catalog)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(directory.retainedEffort).toBe('high')
    expect(directory.groups[0]?.models).toEqual([
      { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ])
    expect(nativeModelOptions('codex', catalog, { provider: 'bridge/codex', model: 'gpt-5.4' })).toEqual({ model: null, reasoningEffort: null })
    expect(current).toEqual({ model: null, reasoningEffort: null })
    expect(catalog.models[0]?.reasoning?.defaultEffort).toBe('medium')
  })

  it('a native custom model displays its actual default effort without advertising selectable depths', () => {
    const catalog: NativeModelDirectory = {
      backend: 'codex',
      defaultModel: 'custom/deepseek',
      defaultReasoningEffort: 'high',
      current: { model: null, reasoningEffort: null },
      models: [{ id: 'custom/deepseek', name: 'DeepSeek' }],
    }
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, catalog)
    expect(directory.groups).toEqual([{ id: 'bridge/codex', name: 'Codex', models: [{ id: 'custom/deepseek', name: 'DeepSeek' }] }])
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'custom/deepseek', reasoningEffort: 'high' })
    expect(directory.retainedEffort).toBe('high')
    expect(nativeModelOptions('codex', catalog, { provider: 'bridge/codex', model: 'custom/deepseek' })).toEqual({ model: null, reasoningEffort: null })
    expect(() => nativeModelOptions('codex', catalog, { provider: 'bridge/codex', model: 'custom/deepseek', reasoningEffort: 'high' })).toThrow('Native reasoning effort is unavailable')
  })

  it('unknown effective effort does not borrow a model-list preset or invent a reasoning level', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, CATALOG)
    expect(directory.groups[0]?.models[0]).toEqual({ id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } })
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4' })
    expect(directory.retainedEffort).toBeUndefined()
  })

  it('explicit durable efforts take precedence over the read-only native default caption', () => {
    const catalog: NativeModelDirectory = { ...CATALOG, defaultReasoningEffort: 'high' }
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: 'medium' }, catalog)
    expect(directory.groups[0]?.models[0]?.name).toBe('GPT-5.4')
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'medium' })
    expect(nativeModelOptions('codex', catalog, { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'medium' })).toEqual({ model: null, reasoningEffort: 'medium' })
  })

  it('a nondefault model never claims the native default model effort as its own', () => {
    const directory = nativeModelDirectory('codex', { model: 'gpt-5.4-mini', reasoningEffort: null }, { ...CATALOG, defaultReasoningEffort: 'high' })
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4-mini' })
    expect(directory.retainedEffort).toBeUndefined()
  })

  it('reading a fixed default model retains the raw preference while presenting its native effort baseline', () => {
    const current = { model: 'gpt-5.4', reasoningEffort: null }
    const directory = nativeModelDirectory('codex', current, { ...CATALOG, defaultReasoningEffort: 'high' })
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(current).toEqual({ model: 'gpt-5.4', reasoningEffort: null })
  })

  it('uses native routes and the durable native selection rather than the GET current hint', () => {
    const directory = nativeModelDirectory('codex', { model: 'gpt-5.4-mini', reasoningEffort: null }, CATALOG)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4-mini' })
    expect(directory.groups).toEqual([{ id: 'bridge/codex', name: 'Codex', models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ] }])
    expect(directory.routable).toBe(true)
    expect(directory.pending).toBeNull()
  })

  it('the single default model row sends nullable resets instead of fixing catalog display hints', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, CATALOG)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4' })
    expect(directory.groups[0]?.models[0]?.reasoning).toEqual({ efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] })
    expect(nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'gpt-5.4' })).toEqual({ model: null, reasoningEffort: null })
    expect(nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'high' })).toEqual({ model: null, reasoningEffort: 'high' })
  })

  it('deduplicates repeated wire ids while distinguishing different models with the same label', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, {
      ...CATALOG,
      models: [{ id: 'gpt-5.4', name: 'GPT' }, { id: 'gpt-5.4', name: 'Duplicate wire row' }, { id: 'gpt-5.4-mini', name: 'GPT' }],
    })
    expect(directory.groups[0]?.models).toEqual([{ id: 'gpt-5.4', name: 'GPT (gpt-5.4)' }, { id: 'gpt-5.4-mini', name: 'GPT (gpt-5.4-mini)' }])
  })

  it('retains an unavailable native caption but does not claim it is routable', () => {
    const directory = nativeModelDirectory('codex', { model: 'removed-native-model', reasoningEffort: 'deep' }, CATALOG)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'removed-native-model', reasoningEffort: 'deep' })
    expect(directory.retainedEffort).toBe('deep')
    expect(directory.routable).toBe(false)
  })

  it('a Claude model without native reasoning metadata has no client-owned depth list', () => {
    const directory = nativeModelDirectory('claude', { model: 'claude-sonnet-4-6', reasoningEffort: null }, {
      backend: 'claude',
      current: { model: null, reasoningEffort: null },
      defaultModel: 'claude-sonnet-4-6',
      models: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }],
    })
    expect(directory.groups).toEqual([{ id: 'bridge/claude', name: 'Claude', models: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }] }])
  })

  it('an unresolved default model has one placeholder with no invented reasoning metadata', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, { ...CATALOG, defaultModel: undefined })
    expect(directory.groups[0]?.models.map(model => model.id)).toEqual(['', 'gpt-5.4', 'gpt-5.4-mini'])
    expect(directory.groups[0]?.models[0]).toEqual({ id: '', name: 'Native default' })
    expect(() => nativeModelOptions('codex', { ...CATALOG, defaultModel: undefined }, { provider: 'bridge/codex', model: '', reasoningEffort: 'high' })).toThrow('Native reasoning effort is unavailable')
  })

  it('resets the effort on model changes and rejects backend changes, unknown models, and unknown depths', () => {
    expect(nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'gpt-5.4-mini' })).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: null })
    expect(() => nativeModelOptions('codex', CATALOG, { provider: 'openai', model: 'gpt-5.4' })).toThrow('Native session kernel cannot be changed')
    expect(() => nativeModelOptions('codex', CATALOG, { provider: 'bridge/claude', model: 'gpt-5.4' })).toThrow('Native session kernel cannot be changed')
    expect(() => nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'not-in-catalog' })).toThrow('Native model is unavailable')
    expect(() => nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'gpt-5.4', reasoningEffort: 'max' })).toThrow('Native reasoning effort is unavailable')
    expect(() => nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: 'gpt-5.4-mini', reasoningEffort: 'high' })).toThrow('Native reasoning effort is unavailable')
  })

  it('requires explicit nullable native preferences instead of treating unknown values as defaults', () => {
    expect(isNativeTurnOptions({ model: null, reasoningEffort: null })).toBe(true)
    expect(isNativeTurnOptions({ model: 'native-model', reasoningEffort: 'native-depth' })).toBe(true)
    for (const value of [undefined, null, {}, { model: null }, { model: '', reasoningEffort: null }, { model: null, reasoningEffort: 3 }])
      expect(isNativeTurnOptions(value)).toBe(false)
  })
})
