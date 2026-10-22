import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLanguage } from './index.detector'

const native = vi.hoisted(() => ({ locales: [] as { languageTag: string }[] }))

vi.mock('expo-localization', () => ({ getLocales: () => native.locales }))

function withDeviceLocale(languageTag: string) {
  native.locales = [{ languageTag }]
}

afterEach(() => {
  native.locales = []
})

describe('detectLanguage', () => {
  it('maps zh regions to zh-CN', () => {
    withDeviceLocale('zh-Hans-CN')
    expect(detectLanguage()).toBe('zh-CN')
  })

  it('maps ko regions to ko-KR', () => {
    withDeviceLocale('ko-KR')
    expect(detectLanguage()).toBe('ko-KR')
  })

  it('falls back to en-US for unsupported regions', () => {
    withDeviceLocale('fr-FR')
    expect(detectLanguage()).toBe('en-US')
  })

  it('falls back to en-US when the device reports no locale', () => {
    expect(detectLanguage()).toBe('en-US')
  })
})
