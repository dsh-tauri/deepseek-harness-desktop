export type RequestHeaders = Record<string, string>

export interface HeaderRow {
  name: string
  value: string
}

export type HeaderFailureKey = 'headerNameInvalid' | 'headerNameDuplicate' | 'headerValueInvalid'

export interface HeaderFailure {
  index: number
  key: HeaderFailureKey
}

/** HTTP 头名只能是 token：Fetch 拒绝带分隔符的名字，写进去会让整段提供方配置解析失败。 */
const HEADER_NAME = /^[!#$%&'*+\-.^`|~\w]+$/

/** 头值按 HTTP field-value：HTAB、空格、可见 ASCII 与 Latin-1。CR/LF/NUL 会让 Fetch 拒绝整段配置；其余控制字符与 DEL 也不属于 field-value。 */
const HEADER_VALUE_INVALID = /[^\t\x20-\x7E\x80-\xFF]/

export function requestHeadersOf(value: unknown): RequestHeaders {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {}
  const headers: RequestHeaders = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string')
      headers[name] = entry
  }
  return headers
}

export function headerRowsOf(headers: RequestHeaders): HeaderRow[] {
  const rows = Object.entries(headers).map(([name, value]) => ({ name, value }))
  return rows.length === 0 ? [{ name: '', value: '' }] : rows
}

function isBlankRow(row: HeaderRow): boolean {
  return row.name.trim().length === 0 && row.value.trim().length === 0
}

export function requestHeaderFailure(rows: readonly HeaderRow[]): HeaderFailure | undefined {
  const named = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (isBlankRow(row))
      continue
    const name = row.name.trim()
    if (!HEADER_NAME.test(name))
      return { index, key: 'headerNameInvalid' }
    const key = name.toLowerCase()
    if (named.has(key))
      return { index, key: 'headerNameDuplicate' }
    named.add(key)
    if (HEADER_VALUE_INVALID.test(row.value))
      return { index, key: 'headerValueInvalid' }
  }
  return undefined
}

export function requestHeadersFromRows(rows: readonly HeaderRow[]): RequestHeaders {
  const named = new Map<string, [string, string]>()
  for (const row of rows) {
    if (isBlankRow(row))
      continue
    const name = row.name.trim()
    named.set(name.toLowerCase(), [name, row.value.trim()])
  }
  return Object.fromEntries(named.values())
}

export function hasUserAgentHeader(headers: RequestHeaders): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === 'user-agent')
}
