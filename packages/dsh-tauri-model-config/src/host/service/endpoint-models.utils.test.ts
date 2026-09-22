import { describe, expect, it } from 'vitest'
import {
  apiKeyRefOf,
  endpointOf,
  getPath,
  listingHeaders,
  modelsListingUrl,
  normalizeEndpointModel,
  normalizeEndpointModels,
  parseProfilePath,
} from './endpoint-models.utils'

describe('normalizeEndpointModel', () => {
  it('reads the aliases OpenAI-compatible endpoints publish', () => {
    expect(normalizeEndpointModel({ id: 'm', context_length: 131072, max_output_tokens: 8192 }))
      .toEqual({ id: 'm', contextWindow: 131072, maxTokens: 8192 })
    expect(normalizeEndpointModel({ id: 'm', context_window: 32768, max_tokens: 4096 }))
      .toEqual({ id: 'm', contextWindow: 32768, maxTokens: 4096 })
    expect(normalizeEndpointModel({ id: 'm', max_model_len: 262144 }))
      .toEqual({ id: 'm', contextWindow: 262144 })
  })

  it('reads the nested capacity objects', () => {
    expect(normalizeEndpointModel({ id: 'm', limit: { context: 200000, output: 8192 } }))
      .toEqual({ id: 'm', contextWindow: 200000, maxTokens: 8192 })
    expect(normalizeEndpointModel({ id: 'm', top_provider: { max_completion_tokens: 1024 } }))
      .toEqual({ id: 'm', maxTokens: 1024 })
  })

  it('prefers the first disclosed alias in order', () => {
    expect(normalizeEndpointModel({ id: 'm', contextWindow: 1, context_window: 2 }))
      .toEqual({ id: 'm', contextWindow: 1 })
  })

  it('leaves undisclosed capacity empty rather than guessing', () => {
    expect(normalizeEndpointModel({ id: 'm', name: 'M' })).toEqual({ id: 'm', name: 'M' })
    expect(normalizeEndpointModel({ id: 'm', context_window: 0, max_tokens: -1 })).toEqual({ id: 'm' })
  })

  it('rejects entries without a usable id', () => {
    expect(normalizeEndpointModel({ id: '  ' })).toBeUndefined()
    expect(normalizeEndpointModel('m')).toBeUndefined()
    expect(normalizeEndpointModel(undefined)).toBeUndefined()
  })
})

describe('normalizeEndpointModels', () => {
  it('reads the data envelope and drops unusable rows', () => {
    expect(normalizeEndpointModels({ data: [{ id: 'a' }, { name: 'no id' }, { id: 'b', max_tokens: 4 }] }))
      .toEqual([{ id: 'a' }, { id: 'b', maxTokens: 4 }])
  })

  it('reports a listing without a data array as unknown', () => {
    expect(normalizeEndpointModels({ error: 'nope' })).toBeUndefined()
    expect(normalizeEndpointModels(undefined)).toBeUndefined()
  })
})

describe('profile resolution', () => {
  const section = { providers: { local: { baseURL: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'LOCAL_API_KEY' } } }

  it('reads a nested profile by path', () => {
    expect(getPath(section, ['providers', 'local'])).toEqual(section.providers.local)
  })

  it('returns undefined when any segment is missing', () => {
    expect(getPath(section, ['providers', 'absent'])).toBeUndefined()
    expect(getPath(undefined, ['providers'])).toBeUndefined()
  })

  it('parses the query spelling of a profile path', () => {
    expect(parseProfilePath('["providers","local"]')).toEqual(['providers', 'local'])
    expect(parseProfilePath('[]')).toEqual([])
    expect(parseProfilePath(undefined)).toEqual([])
    expect(parseProfilePath('{"not":"an array"}')).toEqual([])
    expect(parseProfilePath('[')).toEqual([])
  })

  it('prefers the base URL the form shows over the stored one', () => {
    expect(endpointOf(section.providers.local, ' http://localhost:9000/v1 ')).toBe('http://localhost:9000/v1')
    expect(endpointOf(section.providers.local, '   ')).toBe('http://127.0.0.1:8000/v1')
    expect(endpointOf(undefined, undefined)).toBeUndefined()
  })

  it('reads the credential reference the profile names', () => {
    expect(apiKeyRefOf(section.providers.local)).toBe('LOCAL_API_KEY')
    expect(apiKeyRefOf({ apiKeyEnv: '  ' })).toBeUndefined()
    expect(apiKeyRefOf(undefined)).toBeUndefined()
  })

  it('appends the listing segment without doubling slashes', () => {
    expect(modelsListingUrl('http://127.0.0.1:8000/v1/')).toBe('http://127.0.0.1:8000/v1/models')
    expect(modelsListingUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1/models')
  })
})

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

describe('listingHeaders', () => {
  const profile = { headers: { 'X-Custom': 'saved', 'X-Number': 1, 'Accept': 'text/plain' } }

  it('sends stored string headers and forces the listing accept', () => {
    expect(headerRecord(listingHeaders(profile, undefined, undefined)))
      .toEqual({ 'x-custom': 'saved', 'accept': 'application/json' })
  })

  it('lets the form replace stored headers, including clearing them', () => {
    expect(headerRecord(listingHeaders(profile, '{"X-Draft":"1"}', undefined)))
      .toEqual({ 'x-draft': '1', 'accept': 'application/json' })
    expect(headerRecord(listingHeaders(profile, '{}', undefined)))
      .toEqual({ accept: 'application/json' })
  })

  it('keeps stored headers when the form value is not an object', () => {
    expect(headerRecord(listingHeaders(profile, '[]', undefined))['x-custom']).toBe('saved')
    expect(headerRecord(listingHeaders(profile, '{', undefined))['x-custom']).toBe('saved')
    expect(headerRecord(listingHeaders(profile, '   ', undefined))['x-custom']).toBe('saved')
  })

  it('forces authorization from the resolved key over a custom authorization header', () => {
    expect(headerRecord(listingHeaders(
      { headers: { Authorization: 'raw' } },
      undefined,
      'secret',
    )).authorization).toBe('Bearer secret')
  })

  it('keeps a custom authorization header when no key is resolved', () => {
    expect(headerRecord(listingHeaders(
      { headers: { Authorization: 'raw' } },
      undefined,
      undefined,
    )).authorization).toBe('raw')
  })

  it('drops a value the Fetch layer refuses without dropping the rest', () => {
    expect(headerRecord(listingHeaders(
      { headers: { 'X-Ok': '1', 'X-Bad': 'a\nb' } },
      undefined,
      undefined,
    ))).toEqual({ 'x-ok': '1', 'accept': 'application/json' })
  })
})
