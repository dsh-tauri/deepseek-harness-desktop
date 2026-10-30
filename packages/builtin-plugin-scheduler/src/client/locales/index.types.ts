import type { locale } from './index'

export type Translate = typeof locale.text
export type LocaleKey = Parameters<Translate>[0]
