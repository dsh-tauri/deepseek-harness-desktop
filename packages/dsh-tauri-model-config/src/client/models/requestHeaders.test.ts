import { describe, expect, it } from 'vitest'
import {
  hasUserAgentHeader,
  headerRowsOf,
  requestHeaderFailure,
  requestHeadersFromRows,
  requestHeadersOf,
} from './requestHeaders'

describe('requestHeadersOf', () => {
  it('reads the string entries and drops every other value type', () => {
    expect(requestHeadersOf({ 'X-Text': 'a', 'X-Number': 1, 'X-Null': null, 'X-Object': {} }))
      .toEqual({ 'X-Text': 'a' })
  })

  it('reads a declaration that is not a plain object as the empty map', () => {
    expect(requestHeadersOf(undefined)).toEqual({})
    expect(requestHeadersOf(null)).toEqual({})
    expect(requestHeadersOf(['X-A'])).toEqual({})
    expect(requestHeadersOf('X-A: 1')).toEqual({})
  })
})

describe('headerRowsOf', () => {
  it('keeps the stored order of the configured names', () => {
    expect(headerRowsOf({ 'X-B': '2', 'X-A': '1' }))
      .toEqual([{ name: 'X-B', value: '2' }, { name: 'X-A', value: '1' }])
  })

  it('offers one blank row when nothing is configured', () => {
    expect(headerRowsOf({})).toEqual([{ name: '', value: '' }])
  })
})

describe('requestHeaderFailure', () => {
  it('accepts a token name with a single-line value', () => {
    expect(requestHeaderFailure([{ name: 'X-Custom-Header', value: 'a b' }])).toBeUndefined()
  })

  it('ignores a fully blank row', () => {
    expect(requestHeaderFailure([{ name: '', value: '' }, { name: '  ', value: ' ' }])).toBeUndefined()
  })

  it('rejects a name carrying a separator the Fetch layer refuses', () => {
    expect(requestHeaderFailure([{ name: 'X-Api Key', value: '1' }]))
      .toEqual({ index: 0, key: 'headerNameInvalid' })
    expect(requestHeaderFailure([{ name: 'X-Api:Key', value: '1' }]))
      .toEqual({ index: 0, key: 'headerNameInvalid' })
  })

  it('rejects a value that carries no name', () => {
    expect(requestHeaderFailure([{ name: '', value: 'orphan' }]))
      .toEqual({ index: 0, key: 'headerNameInvalid' })
  })

  it('rejects a name that repeats under a different casing', () => {
    const rows = [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }]
    expect(requestHeaderFailure(rows)).toEqual({ index: 1, key: 'headerNameDuplicate' })
  })

  it('reports the position of the offending row', () => {
    const rows = [{ name: 'X-A', value: '1' }, { name: 'X-B', value: 'a\nb' }]
    expect(requestHeaderFailure(rows)).toEqual({ index: 1, key: 'headerValueInvalid' })
  })

  it('rejects a value carrying a carriage return', () => {
    expect(requestHeaderFailure([{ name: 'X-A', value: 'a\r\nX-B: 2' }]))
      .toEqual({ index: 0, key: 'headerValueInvalid' })
  })

  it('rejects a value carrying a control character the header grammar forbids', () => {
    expect(requestHeaderFailure([{ name: 'X-A', value: 'a\u0000b' }]))
      .toEqual({ index: 0, key: 'headerValueInvalid' })
    expect(requestHeaderFailure([{ name: 'X-A', value: 'a\u007Fb' }]))
      .toEqual({ index: 0, key: 'headerValueInvalid' })
    expect(requestHeaderFailure([{ name: 'X-A', value: 'a\u000Bb' }]))
      .toEqual({ index: 0, key: 'headerValueInvalid' })
  })

  it('rejects a value carrying a character outside the Latin-1 range Fetch encodes', () => {
    expect(requestHeaderFailure([{ name: 'X-A', value: '中文' }]))
      .toEqual({ index: 0, key: 'headerValueInvalid' })
  })

  it('accepts a value carrying a horizontal tab the header grammar keeps', () => {
    expect(requestHeaderFailure([{ name: 'X-A', value: 'a\tb' }])).toBeUndefined()
  })

  it('accepts a value carrying a Latin-1 letter above ASCII', () => {
    expect(requestHeaderFailure([{ name: 'X-A', value: 'café' }])).toBeUndefined()
  })
})

describe('requestHeadersFromRows', () => {
  it('trims names and values and drops blank rows', () => {
    const rows = [{ name: '', value: '' }, { name: ' X-A ', value: ' 1 ' }]
    expect(requestHeadersFromRows(rows)).toEqual({ 'X-A': '1' })
  })

  it('collapses names differing only by case onto the last value', () => {
    const rows = [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }]
    expect(requestHeadersFromRows(rows)).toEqual({ 'x-a': '2' })
  })

  it('keeps an empty value for a named header', () => {
    expect(requestHeadersFromRows([{ name: 'X-A', value: '' }])).toEqual({ 'X-A': '' })
  })

  it('returns the empty map for rows that carry nothing', () => {
    expect(requestHeadersFromRows([])).toEqual({})
  })
})

describe('hasUserAgentHeader', () => {
  it('matches the name case-insensitively', () => {
    expect(hasUserAgentHeader({ 'user-agent': 'x' })).toBe(true)
    expect(hasUserAgentHeader({ 'User-Agent': 'x' })).toBe(true)
  })

  it('does not match a different header', () => {
    expect(hasUserAgentHeader({ 'x-user-agent': 'x' })).toBe(false)
    expect(hasUserAgentHeader({})).toBe(false)
  })
})
