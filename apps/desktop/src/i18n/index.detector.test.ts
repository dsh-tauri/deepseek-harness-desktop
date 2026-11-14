import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_STORAGE_KEY, languageDetector, normalizeLanguage, resolveLanguage } from './index.detector'

const store = new Map<string, string>()

function detect() {
  return (languageDetector.detect as () => string)()
}

function inject(locale: { language?: string | null, languages?: string[] } | undefined) {
  if (locale === undefined) {
    delete (globalThis as { __DSH_DESKTOP_LOCALE__?: unknown }).__DSH_DESKTOP_LOCALE__
    return
  }
  ;(globalThis as { __DSH_DESKTOP_LOCALE__?: unknown }).__DSH_DESKTOP_LOCALE__ = locale
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  })
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
  inject(undefined)
})

afterEach(() => {
  inject(undefined)
  vi.unstubAllGlobals()
})

describe('normalizeLanguage', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['zh_CN.UTF-8', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['ZH_cn', 'zh-CN'],
    ['en', 'en-US'],
    ['en_GB.UTF-8', 'en-US'],
    ['ko_KR.UTF-8', 'ko-KR'],
    ['ru_RU@euro', 'ru-RU'],
  ])('folds %s onto the bundled %s', (raw, expected) => {
    expect(normalizeLanguage(raw)).toBe(expected)
  })

  it.each(['', '   ', 'C', 'POSIX', 'C.UTF-8', 'fr-FR', 'ja_JP.UTF-8'])(
    'returns null for the unsupported tag %s',
    (raw) => {
      expect(normalizeLanguage(raw)).toBeNull()
    },
  )

  it('returns null for missing values', () => {
    expect(normalizeLanguage(null)).toBeNull()
    expect(normalizeLanguage(undefined)).toBeNull()
  })
})

describe('resolveLanguage', () => {
  it('takes the first candidate that resolves to a bundled language', () => {
    expect(resolveLanguage(['fr-FR', 'zh_CN.UTF-8', 'en-US'])).toBe('zh-CN')
  })

  it('falls back to English only when every candidate is unusable', () => {
    expect(resolveLanguage(['fr-FR', null, 'C'])).toBe('en-US')
  })
})

describe('languageDetector.detect', () => {
  it('prefers the language the user picked before', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh_CN.UTF-8')
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    expect(detect()).toBe('zh-CN')
  })

  it('falls back to the system languages the desktop probed', () => {
    inject({ languages: ['zh_CN.UTF-8', 'en-US'] })
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    expect(detect()).toBe('zh-CN')
  })

  it('uses the injected explicit choice from the desktop shell', () => {
    inject({ language: 'zh-CN', languages: ['en-US'] })
    expect(detect()).toBe('zh-CN')
  })

  it('keeps an explicit choice ahead of a conflicting system language', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ko-KR')
    inject({ language: 'zh-CN', languages: ['zh-CN'] })
    expect(detect()).toBe('ko-KR')
  })

  it('falls back to the navigator languages when nothing is injected', () => {
    vi.stubGlobal('navigator', { language: 'zh-TW', languages: ['zh-TW', 'en-US'] })
    expect(detect()).toBe('zh-CN')
  })

  it('never leaves an unsupported system language unmapped to a bundled resource', () => {
    inject({ languages: ['fr_FR.UTF-8'] })
    vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE'] })
    expect(detect()).toBe('en-US')
  })

  it('does not persist anything while detecting', () => {
    inject({ languages: ['zh_CN.UTF-8'] })
    expect(detect()).toBe('zh-CN')
    expect(store.size).toBe(0)
  })
})
