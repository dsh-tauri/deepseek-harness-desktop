const LEGAL_API_KEY = /^[\x21-\x7E]+$/

const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

export type ApiKeyFailureKey = 'keyBlank' | 'keyIllegalCharacters'

function isQuoted(value: string): boolean {
  const first = value[0]
  if (first !== '"' && first !== '\'' && first !== '`')
    return false
  return value.length > 1 && value.endsWith(first)
}

export function apiKeyFailure(draft: string): ApiKeyFailureKey | undefined {
  if (draft.length === 0)
    return undefined
  const value = draft.trim()
  if (value.length === 0)
    return 'keyBlank'
  if (ENV_LINE.test(value) || isQuoted(value))
    return 'keyIllegalCharacters'
  if (!LEGAL_API_KEY.test(value))
    return 'keyIllegalCharacters'
  return undefined
}
