import { describe, expect, it } from 'vitest'
import {
  parseRequestHeaders,
  requestHeaderFailure,
  requestHeadersRecord,
  requestHeadersText,
} from './requestHeaders.ts'

describe('parseRequestHeaders', () => {
  it('reads one name-value pair per line and ignores blanks and comments', () => {
    const text = [
      '# a comment',
      '',
      'X-Org-Id: 12345',
      '   X-Trace: abc   ',
      'x-empty:',
    ].join('\n')
    expect(parseRequestHeaders(text)).toEqual([
      { name: 'X-Org-Id', value: '12345' },
      { name: 'X-Trace', value: 'abc' },
      { name: 'x-empty', value: '' },
    ])
  })

  it('keeps the first colon as the separator so values may contain colons', () => {
    expect(parseRequestHeaders('Authorization: Bearer a:b:c')).toEqual([
      { name: 'Authorization', value: 'Bearer a:b:c' },
    ])
  })

  it('treats a line without a separator as a name-only header', () => {
    expect(parseRequestHeaders('X-Flag')).toEqual([{ name: 'X-Flag', value: '' }])
  })

  it('returns nothing for empty input', () => {
    expect(parseRequestHeaders('')).toEqual([])
  })
})

describe('requestHeaderFailure', () => {
  it('accepts fetch-representable names and values', () => {
    expect(requestHeaderFailure([{ name: 'X-Org-Id', value: 'a b\tc' }])).toBeUndefined()
    expect(requestHeaderFailure([])).toBeUndefined()
  })

  it('rejects names outside the HTTP token charset', () => {
    expect(requestHeaderFailure([{ name: 'X Org', value: '1' }])).toBe('headerNameInvalid')
    expect(requestHeaderFailure([{ name: '', value: '1' }])).toBe('headerNameInvalid')
    expect(requestHeaderFailure([{ name: 'X-Org:Id', value: '1' }])).toBe('headerNameInvalid')
  })

  it('rejects values that a header cannot carry', () => {
    expect(requestHeaderFailure([{ name: 'X-Org', value: 'a\nb' }])).toBe('headerValueInvalid')
    expect(requestHeaderFailure([{ name: 'X-Org', value: 'a\u4E2D' }])).toBe('headerValueInvalid')
  })

  it('rejects case-insensitive duplicates', () => {
    expect(requestHeaderFailure([
      { name: 'X-Org-Id', value: '1' },
      { name: 'x-org-id', value: '2' },
    ])).toBe('headerNameDuplicate')
  })
})

describe('requestHeadersRecord', () => {
  it('collects the pairs into a settings-shaped record', () => {
    expect(requestHeadersRecord([
      { name: 'X-Org-Id', value: '1' },
      { name: 'X-Trace', value: '' },
    ])).toEqual({ 'X-Org-Id': '1', 'X-Trace': '' })
  })
})

describe('requestHeadersText', () => {
  it('renders a record back into the editable text', () => {
    expect(requestHeadersText({ 'X-Org-Id': '1', 'X-Trace': '' })).toBe('X-Org-Id: 1\nX-Trace: ')
  })

  it('round-trips through parse', () => {
    const record = { 'X-Org-Id': '1', 'Authorization': 'Bearer a:b' }
    expect(requestHeadersRecord(parseRequestHeaders(requestHeadersText(record)))).toEqual(record)
  })

  it('ignores values that are not plain strings', () => {
    expect(requestHeadersText({ ok: '1', bad: 2, worse: null })).toBe('ok: 1')
    expect(requestHeadersText(undefined)).toBe('')
    expect(requestHeadersText(['nope'])).toBe('')
    expect(requestHeadersText('nope')).toBe('')
  })
})
