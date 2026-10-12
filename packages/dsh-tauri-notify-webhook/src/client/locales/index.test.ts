import { describe, expect, it, vi } from 'vitest'

import { PLUGIN_ID } from '../constants/index'
import { en, locale, zh } from './index'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

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

  it('keeps the two trigger labels apart in both languages', () => {
    expect(zh.triggerComplete).not.toBe(zh.triggerAbnormal)
    expect(en.triggerComplete).not.toBe(en.triggerAbnormal)
  })

  it('keeps every interpolation placeholder in both languages', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholders(en[key]), `en.${key}`).toEqual(placeholders(zh[key]))
    }
  })

  it('registers the plugin namespace', () => {
    expect(locale.NS).toBe(PLUGIN_ID)
  })
})
