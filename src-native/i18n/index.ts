import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { languageDetector } from './index.detector'
import { resources } from './index.resource'

/**
 * 与应用同寿的 i18n 实例：
 * - 资源静态打包（仅 en-US / zh-CN），语言由设备区域同步推导（见 index.detector.ts）；
 * - `initAsync: false` 保证模块作用域（store 模块、通知处理器等非 React 代码）里 `i18n.t` 立即可用；
 * - 扁平 dot-notation key + 关闭 keySeparator/nsSeparator，与桌面端 `src/i18n` 约定保持一致。
 */
const instance = i18next.use(languageDetector).use(initReactI18next)

void instance.init({
  resources,
  fallbackLng: {
    'en-*': ['en-US'],
    'zh-*': ['zh-CN'],
    'default': ['en-US'],
  },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
})

export const i18n = instance
