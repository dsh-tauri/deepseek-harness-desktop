import en_US from './locales/en-US.json'
import ko_KR from './locales/ko-KR.json'
import ru_RU from './locales/ru-RU.json'
import zh_CN from './locales/zh-CN.json'

export const resources = {
  'en-US': { translation: en_US },
  'zh-CN': { translation: zh_CN },
  'ko-KR': { translation: ko_KR },
  'ru-RU': { translation: ru_RU },
} as const
