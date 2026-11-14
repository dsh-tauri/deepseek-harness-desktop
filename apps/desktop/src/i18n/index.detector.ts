import type { LanguageDetectorModule } from 'i18next'
import type { resources } from './index.resource'

export type BundledLanguage = keyof typeof resources

/** 用户显式选择语言的持久化 key。 */
export const LANGUAGE_STORAGE_KEY = 'deepseek-harness-desktop-language'

/** 桌面壳注入页面的语言初始化数据（见 Rust `config::i18n::PageLocale`）。 */
export interface DesktopLocaleInjection {
  /** 用户在桌面端手动选过的语言；从未选过时为 null。 */
  language?: string | null
  /** 系统语言，按优先级排列。 */
  languages?: readonly string[]
}

/** 语言主标签 → 已打包资源 id，顺序即探测顺序。 */
const BUNDLED_PREFIXES: ReadonlyArray<readonly [string, BundledLanguage]> = [
  ['zh', 'zh-CN'],
  ['en', 'en-US'],
  ['ko', 'ko-KR'],
  ['ru', 'ru-RU'],
]

/**
 * 把任意来源的语言标记收敛到已打包的资源 id。
 *
 * `zh_CN.UTF-8` / `zh-Hans-CN` / `zh-TW` 都落到打包的 `zh-CN`：资源只有四个整语言，
 * 不归一化就会落到 i18next 的缺省英文。`C` / `POSIX` / 未打包语言返回 null，由调用方
 * 继续往下探测，绝不在这里臆造一个默认值。
 */
export function normalizeLanguage(value: string | null | undefined): BundledLanguage | null {
  if (!value)
    return null
  const tag = value.trim().split(/[.@]/)[0].replace(/_/g, '-').trim().toLowerCase()
  if (tag === '' || tag === 'c' || tag === 'posix')
    return null
  const primary = tag.split('-')[0]
  return BUNDLED_PREFIXES.find(([prefix]) => prefix === primary)?.[1] ?? null
}

/** 桌面壳注入的语言初始化数据；独立壳层页与浏览器里没有该注入。 */
export function desktopLocaleInjection(): DesktopLocaleInjection | undefined {
  return (globalThis as { __DSH_DESKTOP_LOCALE__?: DesktopLocaleInjection }).__DSH_DESKTOP_LOCALE__
}

/**
 * 系统语言候选：桌面壳探测的顺序优先，其后是浏览器自己的 `navigator`。
 *
 * 两者都要读：注入数据在桌面端最准（能问到 `gsettings` 与 `/etc/default/locale`），
 * 浏览器数据则覆盖独立壳层页（dev）与任何未注入的场景。
 */
export function systemLanguages(): string[] {
  const injected = desktopLocaleInjection()?.languages ?? []
  const navigatorTags = typeof navigator === 'undefined'
    ? []
    : [...(navigator.languages ?? []), navigator.language]
  return [...injected, ...navigatorTags].filter(tag => typeof tag === 'string' && tag !== '')
}

/** 按优先级取第一个可用的已打包语言；全部落空时回到英文。 */
export function resolveLanguage(candidates: ReadonlyArray<string | null | undefined>): BundledLanguage {
  for (const candidate of candidates) {
    const bundled = normalizeLanguage(candidate)
    if (bundled !== null)
      return bundled
  }
  return 'en-US'
}

/** 用户上次的显式选择：本地存储优先，其次后端持久化值，再次桌面壳注入值。 */
function storedLanguage(): string | null {
  return localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? null
}

/** 同步语言探测：显式选择 → 系统语言 → 英文。初始化阶段不写任何持久化状态。 */
export const languageDetector: LanguageDetectorModule = {
  type: 'languageDetector',
  detect: () => resolveLanguage([
    storedLanguage(),
    desktopLocaleInjection()?.language,
    ...systemLanguages(),
  ]),
}
