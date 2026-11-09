import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_STORAGE_KEY, languageDetector } from './index.detector'

const mocks = vi.hoisted(() => ({
  setting: { language: null as string | null },
  invoke: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../store', () => ({ store: { setting: mocks.setting } }))

function detect() {
  return (languageDetector.detect as () => string)()
}

beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  })
  vi.stubGlobal('navigator', { language: 'en-US' })
})

afterEach(() => {
  mocks.setting.language = null
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('languageDetector.detect', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['ko', 'ko-KR'],
    ['ru', 'ru-RU'],
    ['en', 'en-US'],
  ])('expands the backend short code %s to %s', (stored, expected) => {
    mocks.setting.language = stored
    expect(detect()).toBe(expected)
  })

  it('expands a short code saved in localStorage', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ZH')
    expect(detect()).toBe('zh-CN')
  })

  it('keeps a full tag unchanged', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ko-KR')
    mocks.setting.language = 'zh'
    expect(detect()).toBe('ko-KR')
  })

  it('falls back to the navigator language when nothing is saved', () => {
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    expect(detect()).toBe('zh-CN')
  })

  it('falls back to en-US for unsupported navigator languages', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    expect(detect()).toBe('en-US')
  })
})

describe('languageDetector.cacheUserLanguage', () => {
  it('keeps sending the short code to the backend', () => {
    languageDetector.cacheUserLanguage!('zh-CN')
    expect(mocks.invoke).toHaveBeenCalledWith('set_language', { lang: 'zh' })
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN')
  })
})
