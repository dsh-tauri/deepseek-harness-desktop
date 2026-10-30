import { describe, expect, it } from 'vitest'
import {
  declaredThinkingLevels,
  DEFAULT_THINKING_EFFORTS,
  enableThinking,
  supportsTemplateThinking,
  supportsThinking,
  templateThinkingCompat,
  THINKING_LEVELS,
  thinkingEffortsOf,
  toggleThinkingLevel,
  wireValueOf,
} from './model-compat'

describe('thinkingEffortsOf', () => {
  it('reads a declared effort table', () => {
    expect(thinkingEffortsOf({ reasoningEfforts: { off: null, high: 'high' } })).toEqual({ off: null, high: 'high' })
  })

  it('treats a missing, disabled or malformed declaration as empty', () => {
    expect(thinkingEffortsOf({})).toEqual({})
    expect(thinkingEffortsOf({ reasoningEfforts: false })).toEqual({})
    expect(thinkingEffortsOf({ reasoningEfforts: ['high'] })).toEqual({})
    expect(thinkingEffortsOf({ reasoningEfforts: null })).toEqual({})
    expect(thinkingEffortsOf({ reasoningEfforts: 'high' })).toEqual({})
  })

  it('covers every level the model editor offers', () => {
    expect([...THINKING_LEVELS]).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('declaredThinkingLevels / supportsThinking', () => {
  it('lists declared levels', () => {
    expect(declaredThinkingLevels({ reasoningEfforts: { off: null, low: 'low' } })).toEqual(['off', 'low'])
  })

  it('only counts a graded level as thinking support', () => {
    expect(supportsThinking({})).toBe(false)
    expect(supportsThinking({ reasoningEfforts: false })).toBe(false)
    expect(supportsThinking({ reasoningEfforts: { off: null } })).toBe(false)
    expect(supportsThinking({ reasoningEfforts: { off: null, minimal: 'minimal' } })).toBe(true)
  })
})

describe('enableThinking', () => {
  it('falls back to the default graded table when nothing is declared', () => {
    expect(enableThinking({}, undefined)).toEqual(DEFAULT_THINKING_EFFORTS)
    expect(enableThinking({ reasoningEfforts: { off: null } }, undefined)).toEqual(DEFAULT_THINKING_EFFORTS)
  })

  it('keeps an existing declaration untouched', () => {
    const declared = { off: null, minimal: 'minimal' }
    expect(enableThinking({ reasoningEfforts: declared }, undefined)).toEqual(declared)
  })

  it('seeds the table from the preset when the model declares no graded level', () => {
    const preset = { reasoningEfforts: { off: null, low: 'low', high: 'high' } }
    expect(enableThinking({}, preset)).toEqual({ off: null, low: 'low', high: 'high' })
    expect(enableThinking({ reasoningEfforts: { high: 'xhigh' } }, preset)).toEqual({ high: 'xhigh' })
  })
})

describe('toggleThinkingLevel', () => {
  it('adds a level with its own value, and maps off to null', () => {
    expect(toggleThinkingLevel({}, 'high', true)).toEqual({ high: 'high' })
    expect(toggleThinkingLevel({ high: 'high' }, 'off', true)).toEqual({ high: 'high', off: null })
    expect(toggleThinkingLevel({}, 'off', true, 'none')).toEqual({ off: 'none' })
  })

  it('removes a level and reports an empty table as false', () => {
    expect(toggleThinkingLevel({ off: null, high: 'high' }, 'off', false)).toEqual({ high: 'high' })
    expect(toggleThinkingLevel({ high: 'high' }, 'high', false)).toBe(false)
  })

  it('restores custom wire values when re-enabling a level', () => {
    const initial = { extra: 'vendor-extra', high: 'high' }
    const withoutExtra = toggleThinkingLevel(initial, 'extra', false)
    expect(withoutExtra).toEqual({ high: 'high' })
    const restored = toggleThinkingLevel(withoutExtra as Record<string, string | null>, 'extra', true, initial.extra)
    expect(restored).toEqual({ high: 'high', extra: 'vendor-extra' })
  })

  it('collapses to false when the last level is removed without off', () => {
    const initial = { high: 'high' }
    expect(toggleThinkingLevel(initial, 'high', false)).toBe(false)
  })

  it('never mutates its input', () => {
    const efforts = { high: 'high' }
    toggleThinkingLevel(efforts, 'off', true)
    expect(efforts).toEqual({ high: 'high' })
  })
})

describe('supportsTemplateThinking', () => {
  it('requires both the chat template format and the developer-role opt-out', () => {
    expect(supportsTemplateThinking({})).toBe(false)
    expect(supportsTemplateThinking({ compat: { thinkingFormat: 'chat-template' } })).toBe(false)
    expect(supportsTemplateThinking({ compat: { supportsDeveloperRole: false } })).toBe(false)
    expect(supportsTemplateThinking({
      compat: { thinkingFormat: 'chat-template', supportsDeveloperRole: false },
    })).toBe(true)
  })
})

describe('templateThinkingCompat', () => {
  it('writes the three facts and routes the effort through the template kwarg', () => {
    expect(templateThinkingCompat({}, true)).toEqual({
      chatTemplateKwargs: { reasoning_effort: { $var: 'thinking.effort' } },
      thinkingFormat: 'chat-template',
      supportsDeveloperRole: false,
    })
  })

  it('preserves unrelated compat keys and chat template kwargs', () => {
    expect(templateThinkingCompat({
      compat: {
        supportsReasoningEffort: true,
        chatTemplateKwargs: { enable_thinking: true, reasoning_effort: 'low' },
      },
    }, true)).toEqual({
      supportsReasoningEffort: true,
      chatTemplateKwargs: {
        enable_thinking: true,
        reasoning_effort: { $var: 'thinking.effort' },
      },
      thinkingFormat: 'chat-template',
      supportsDeveloperRole: false,
    })
  })

  it('removes the three facts and drops the kwarg when turning off', () => {
    expect(templateThinkingCompat({
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: 'chat-template',
        supportsDeveloperRole: false,
        chatTemplateKwargs: { reasoning_effort: { $var: 'thinking.effort' } },
      },
    }, false)).toEqual({ supportsReasoningEffort: true })
  })

  it('keeps leftover chat template kwargs when turning off', () => {
    expect(templateThinkingCompat({
      compat: {
        thinkingFormat: 'chat-template',
        supportsDeveloperRole: false,
        chatTemplateKwargs: { enable_thinking: true, reasoning_effort: { $var: 'thinking.effort' } },
      },
    }, false)).toEqual({ chatTemplateKwargs: { enable_thinking: true } })
  })

  it('erases the whole compat field when nothing else is configured', () => {
    expect(templateThinkingCompat({
      compat: { thinkingFormat: 'chat-template', supportsDeveloperRole: false },
    }, false)).toBeUndefined()
  })
})

describe('wireValueOf', () => {
  it('prefers a declared custom value over the preset', () => {
    expect(wireValueOf('high', { high: 'xhigh' }, { high: 'high' })).toBe('xhigh')
  })

  it('keeps an explicit null declaration instead of the preset value', () => {
    expect(wireValueOf('high', { high: null }, { high: 'high' })).toBeNull()
  })

  it('falls back to the preset only when the level is undeclared', () => {
    expect(wireValueOf('high', {}, { high: 'high' })).toBe('high')
    expect(wireValueOf('high', {}, undefined)).toBeUndefined()
  })
})
