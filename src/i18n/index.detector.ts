import type { LanguageDetectorModule } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import { store } from '../store'
import { resources } from './index.resource'

/** 语言偏好持久化 key，与 setting store 保持同步 */
export const LANGUAGE_STORAGE_KEY = 'deepseek-harness-desktop-language'

/** 后端 `set_language` 接受的语言短码：zh / ko / en */
function backendLanguage(language: string): 'zh' | 'ko' | 'en' {
  const lower = language.toLowerCase()
  if (lower.startsWith('zh'))
    return 'zh'
  if (lower.startsWith('ko'))
    return 'ko'
  return 'en'
}

/** 浏览器语言 → 已打包的资源 id（默认英文） */
function browserLocale(language: string): 'zh-CN' | 'ko-KR' | 'en-US' {
  const lower = language.toLowerCase()
  if (lower.startsWith('zh'))
    return 'zh-CN'
  if (lower.startsWith('ko'))
    return 'ko-KR'
  return 'en-US'
}

/** 同步语言探测：优先 localStorage 用户选择，其次内存/后端，最后浏览器语言 */
export const languageDetector: LanguageDetectorModule = {
  type: 'languageDetector',
  detect: () => {
    // 用户上次的显式选择（跨重启持久）优先
    let selectedLanguage = localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? ''

    // 会话内切换的语言（store 未持久化，仅作为次优先）
    if (!selectedLanguage)
      selectedLanguage = store.setting.language ?? ''

    if (selectedLanguage)
      return selectedLanguage

    // If no saved language, use device locale or fallback
    const deviceLocale = browserLocale(navigator.language)

    // try exact locale match first
    if (deviceLocale in resources)
      selectedLanguage = deviceLocale
    else
      selectedLanguage = 'en-US'

    return selectedLanguage
  },
  cacheUserLanguage: (language: string) => {
    localStorage?.setItem(LANGUAGE_STORAGE_KEY, language)
    store.setting.language = language
    invoke('set_language', { lang: backendLanguage(language) }).catch((err) => {
      console.warn('[i18n] failed to persist language to backend:', err)
    })
  },
}
