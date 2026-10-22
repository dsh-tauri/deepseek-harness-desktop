import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * i18n 로케일 계약(locale contract).
 *
 * 每个 `src/i18n/locales/*.json` 都是扁平 dot-notation key。新增语言时最容易漏的是
 * 「键集合」「空文案」「占位符」三件事，所以在单元层面统一把关，避免运行时才发现回退。
 */
const LOCALES = ['en-US', 'zh-CN', 'ko-KR'] as const

const readLocale = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>

/** `{{name}}` / `{name}` 两种占位符写法都要保留。 */
const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{\{?\w+\}?\}/g)].map(match => match[0]).sort()

describe('i18n locale contract', () => {
  it('每个语言文件的键集合完全一致', () => {
    const base = Object.keys(readLocale('en-US')).sort()
    expect(base.length).toBeGreaterThan(0)
    for (const locale of LOCALES)
      expect(Object.keys(readLocale(locale)).sort(), locale).toEqual(base)
  })

  it('没有空文案', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(readLocale(locale)))
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0)
    }
  })

  it('每个键的占位符与 en-US 完全一致', () => {
    const english = readLocale('en-US')
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(readLocale(locale)))
        expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders(english[key]))
    }
  })
})
