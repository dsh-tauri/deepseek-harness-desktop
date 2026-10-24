import { createInstance } from 'i18next'
import { resources } from '@/i18n/index.resource'

// issue #1214：桌宠只读原生语言偏好，主窗口的探测器会回写设置。
export const petI18n = createInstance()
void petI18n.init({
  lng: 'en-US',
  fallbackLng: 'en-US',
  resources,
  interpolation: { escapeValue: false },
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
})

export function setPetLanguage(language?: string | null): void {
  const value = (language || (typeof navigator === 'undefined' ? 'en' : navigator.language)).toLowerCase()
  void petI18n.changeLanguage(value.startsWith('zh') ? 'zh-CN' : value.startsWith('ko') ? 'ko-KR' : value.startsWith('ru') ? 'ru-RU' : 'en-US')
  if (typeof document !== 'undefined')
    document.documentElement.lang = petI18n.language
}
