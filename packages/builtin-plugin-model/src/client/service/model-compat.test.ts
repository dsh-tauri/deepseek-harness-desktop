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
    expect(enableThinking({})).toEqual(DEFAULT_THINKING_EFFORTS)
    expect(enableThinking({ reasoningEfforts: { off: null } })).toEqual(DEFAULT_THINKING_EFFORTS)
  })

  it('keeps an existing declaration untouched', () => {
    const declared = { off: null, minimal: 'minimal' }
    expect(enableThinking({ reasoningEfforts: declared })).toEqual(declared)
  })
})

describe('toggleThinkingLevel', () => {
  it('adds a level with its own value, and maps off to null', () => {
    expect(toggleThinkingLevel({}, 'high', true)).toEqual({ high: 'high' })
    expect(toggleThinkingLevel({ high: 'high' }, 'off', true)).toEqual({ high: 'high', off: null })
  })

  it('removes a level and reports an empty table as false', () => {
    expect(toggleThinkingLevel({ off: null, high: 'high' }, 'off', false)).toEqual({ high: 'high' })
    expect(toggleThinkingLevel({ high: 'high' }, 'high', false)).toBe(false)
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
