import { describe, expect, it } from 'vitest'
import { en, zh } from './index'

describe('locales', () => {
  it('en covers every zh key with no extras', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('ships non-empty string values only', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value, `zh.${key}`).toBeTruthy()
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en.${key}`).toBeTruthy()
    }
  })
})
