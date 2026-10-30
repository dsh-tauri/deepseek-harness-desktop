import { describe, expect, it } from 'vitest'
import { PRESET_CATALOG_VERSION } from './model-presets'

describe('model-presets shared', () => {
  it('defines preset catalog version', () => {
    expect(PRESET_CATALOG_VERSION).toBe('pi-ai-builtin-v1')
  })
})
