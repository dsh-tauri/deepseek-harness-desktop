import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { store } from '../store'
import { LANGUAGE_STORAGE_KEY, languageDetector, normalizeLanguage } from './index.detector'
import { resources } from './index.resource'

export const i18n = i18next

void i18next
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: {
      'en': ['en-US'],
      'zh': ['zh-CN'],
      'ko': ['ko-KR'],
      'ru': ['ru-RU'],
      'en-*': ['en-US'],
      'zh-*': ['zh-CN'],
      'ko-*': ['ko-KR'],
      'ru-*': ['ru-RU'],
      'default': ['en-US'],
    },
    resources,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
  })

/** 后端接受的语言短码：zh / ko / en / ru。 */
function backendLanguage(language: string): 'zh' | 'ko' | 'en' | 'ru' {
  const bundled = normalizeLanguage(language) ?? 'en-US'
  return bundled.slice(0, 2) as 'zh' | 'ko' | 'en' | 'ru'
}

/**
 * 提交一次用户显式选择的语言。
 *
 * 桌面壳与内嵌 dsh 页面是两条独立链路：前者读 `.store.dat`，后者读核心的
 * `locale.preference`。只改其中一条就会出现「菜单中文、页面英文」的割裂，
 * 所以两处写入必须在这里同时发生。
 */
export async function changeLanguage(language: string): Promise<void> {
  const bundled = normalizeLanguage(language) ?? 'en-US'
  await i18n.changeLanguage(bundled)
  localStorage?.setItem(LANGUAGE_STORAGE_KEY, bundled)
  store.setting.language = bundled
  await invoke('set_language', { lang: backendLanguage(bundled) })
}
