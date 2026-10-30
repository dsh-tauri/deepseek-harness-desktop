import type { Translate } from '../locales/index.types'

export function failText(t: Translate, error: unknown): string {
  return `${t('failed')}: ${error instanceof Error ? error.message : String(error)}`
}
