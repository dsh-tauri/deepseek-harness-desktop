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

  it('registers the plugin namespace', () => {
    expect(locale.NS).toBe(PLUGIN_ID)
  })
})
