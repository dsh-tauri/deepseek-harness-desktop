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
  it('uses native routes and the durable native selection rather than the GET current hint', () => {
    const directory = nativeModelDirectory('codex', { model: 'gpt-5.4-mini', reasoningEffort: null }, CATALOG)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: 'gpt-5.4-mini' })
    expect(directory.groups).toEqual([{ id: 'bridge/codex', name: 'Codex', models: [
      { id: '', name: 'bridge/codex', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ] }])
    expect(directory.routable).toBe(true)
    expect(directory.pending).toBeNull()
  })

  it('exposes nullable defaults and only actual efforts, without a fake effort level or provider route', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, CATALOG)
    expect(directory.current).toEqual({ provider: 'bridge/codex', model: '' })
    expect(directory.groups[0]?.models[0]?.reasoning).toEqual({ efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] })
    expect(nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: '' })).toEqual({ model: null, reasoningEffort: null })
    expect(nativeModelOptions('codex', CATALOG, { provider: 'bridge/codex', model: '', reasoningEffort: 'high' })).toEqual({ model: null, reasoningEffort: 'high' })
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
    expect(directory.groups).toEqual([{ id: 'bridge/claude', name: 'Claude', models: [
      { id: '', name: 'bridge/claude' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
    ] }])
  })

  it('an unresolved default model has no invented reasoning metadata', () => {
    const directory = nativeModelDirectory('codex', { model: null, reasoningEffort: null }, { ...CATALOG, defaultModel: undefined })
    expect(directory.groups[0]?.models[0]).toEqual({ id: '', name: 'bridge/codex' })
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
