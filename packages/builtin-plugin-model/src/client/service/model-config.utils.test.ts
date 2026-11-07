import type { LlmDiscoveredModel } from '../types/remotes.ts'
import type { ModelDraft } from './model-config.utils.ts'
import { describe, expect, it } from 'vitest'
import { en } from '../models/locales.ts'
import { mergeModelCards, modelConfigNotice } from './model-config.utils.ts'

const PRESETS = {
  'glm-5.3-flash': {
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { off: null, high: 'high' },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
}

const TEMPLATES = { applied: 'applied {n}', none: 'nothing to write', undisclosed: 'undisclosed {n}' }

describe('mergeModelCards preset fallback', () => {
  it('applies preset facts when the endpoint disclosed nothing', () => {
    const merged = mergeModelCards([{ id: 'glm-5.3-flash' }], [], { presets: PRESETS })

    expect(merged.applied).toBe(1)
    expect(merged.undisclosed).toEqual([])
    expect(merged.models[0]).toEqual({
      id: 'glm-5.3-flash',
      contextWindow: 1048576,
      maxTokens: 65535,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, high: 'high' },
    })
  })

  it('keeps the endpoint facts ahead of the preset ones', () => {
    const discovered: LlmDiscoveredModel[] = [{ id: 'glm-5.3-flash', contextWindow: 32000, maxTokens: 4096 }]
    const merged = mergeModelCards([{ id: 'glm-5.3-flash' }], discovered, { presets: PRESETS })

    expect(merged.models[0]).toMatchObject({ contextWindow: 32000, maxTokens: 4096 })
    expect(merged.applied).toBe(1)
  })

  it('rewrites the endpoint facts when overwriting', () => {
    const discovered: LlmDiscoveredModel[] = [{ id: 'glm-5.3-flash', contextWindow: 32000 }]
    const merged = mergeModelCards([{ id: 'glm-5.3-flash', contextWindow: 1 }], discovered, {
      presets: PRESETS,
      overwrite: true,
    })

    expect(merged.models[0]).toMatchObject({ contextWindow: 32000 })
  })

  it('leaves models outside the requested targets untouched', () => {
    const models: ModelDraft[] = [{ id: 'glm-5.3-flash' }, { id: 'vendor-flat' }]
    const merged = mergeModelCards(models, [], { presets: PRESETS, targets: ['vendor-flat'] })

    expect(merged.applied).toBe(0)
    expect(merged.models[0]).toEqual({ id: 'glm-5.3-flash' })
  })

  it('reports an unknown model as undisclosed instead of patching it', () => {
    const merged = mergeModelCards([{ id: 'vendor-flat' }], [], { presets: PRESETS })

    expect(merged.applied).toBe(0)
    expect(merged.undisclosed).toEqual(['vendor-flat'])
  })
})

describe('modelConfigNotice', () => {
  it('falls back to configNoneApplied when nothing was written or hidden', () => {
    const notice = modelConfigNotice({ applied: 0, undisclosed: [] }, {
      applied: en.configApplied,
      none: en.configNoneApplied,
      undisclosed: en.configUndisclosed,
    })
    expect(notice).toBe(en.configNoneApplied)
  })

  it('leaves the none template unused once a model was patched', () => {
    const notice = modelConfigNotice({ applied: 1, undisclosed: [] }, {
      applied: en.configApplied,
      none: en.configNoneApplied,
      undisclosed: en.configUndisclosed,
    })
    expect(notice).toBe(en.configApplied.replace('{n}', '1'))
  })

  it('reports the applied count', () => {
    expect(modelConfigNotice({ applied: 2, undisclosed: [] }, TEMPLATES)).toBe('applied 2')
  })

  it('reports the undisclosed models alone', () => {
    expect(modelConfigNotice({ applied: 0, undisclosed: ['a'] }, TEMPLATES)).toBe('undisclosed 1')
  })

  it('joins both counts', () => {
    expect(modelConfigNotice({ applied: 3, undisclosed: ['a', 'b'] }, TEMPLATES)).toBe('applied 3 undisclosed 2')
  })
})
