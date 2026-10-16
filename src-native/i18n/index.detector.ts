import type { LanguageDetectorModule } from 'i18next'
import { getLocales } from 'expo-localization'

/**
 * App 内没有语言切换入口，语言唯一的来源是设备区域设置，因此检测是**同步**的：
 * 不需要异步 `LanguageDetectorAsyncModule`（lexim 那种「读 store 再回退设备区域」），
 * 也就不需要把语言写回持久化存储。
 */
export function detectLanguage(): string {
  const tag = getLocales()[0]?.languageTag ?? 'en-US'
  return tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export const languageDetector: LanguageDetectorModule = {
  type: 'languageDetector',
  detect: () => detectLanguage(),
}
