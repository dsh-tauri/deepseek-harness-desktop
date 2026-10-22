import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { languageDetector } from './index.detector'
import { resources } from './index.resource'

export const i18n = i18next
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: {
      'en-*': ['en-US'],
      'zh-*': ['zh-CN'],
      'ko-*': ['ko-KR'],
      'default': ['en-US'],
    },
    resources,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    // 仅使用扁平 dot-notation key（见 AGENTS.md），禁用嵌套解析
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
  })
