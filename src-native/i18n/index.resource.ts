import en_US from './locales/en-US.json'
import ko_KR from './locales/ko-KR.json'
import ru_RU from './locales/ru-RU.json'
import zh_CN from './locales/zh-CN.json'

/**
 * 语言资源静态打包进 bundle（App 没有语言包下载/后端拉取路径）。
 * 与桌面端 `src/i18n/index.resource.ts` 一致，只保留当前支持的四个区域。
 */
export const resources = {
  'en-US': { translation: en_US },
  'zh-CN': { translation: zh_CN },
  'ko-KR': { translation: ko_KR },
  'ru-RU': { translation: ru_RU },
} as const
