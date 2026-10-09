import type { EndpointModelCard } from '../server/routes/index.types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
      return value
  }
  return undefined
}

function nonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0)
      return value
  }
  return undefined
}

function nested(source: Record<string, unknown> | undefined, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

export function normalizeEndpointModel(value: unknown): EndpointModelCard | undefined {
  if (!isRecord(value))
    return undefined
  const id = nonEmptyText(value.id)
  if (id === undefined)
    return undefined
  const limit = isRecord(value.limit) ? value.limit : undefined
  const topProvider = isRecord(value.top_provider) ? value.top_provider : undefined
  const contextWindow = positiveInteger(
    value.contextWindow,
    value.context_window,
    value.context_length,
    value.max_input_tokens,
    value.max_model_len,
    nested(limit, 'context'),
  )
  const maxTokens = positiveInteger(
    value.maxOutputTokens,
    value.max_output_tokens,
    value.maxTokens,
    value.max_tokens,
    value.max_output_length,
    nested(limit, 'output'),
    nested(topProvider, 'max_completion_tokens'),
  )
  const name = nonEmptyText(value.name)
  return {
    id,
    ...name === undefined ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

export function normalizeEndpointModels(payload: unknown): EndpointModelCard[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data))
    return undefined
  const cards: EndpointModelCard[] = []
  for (const entry of payload.data) {
    const card = normalizeEndpointModel(entry)
    if (card !== undefined)
      cards.push(card)
  }
  return cards
}

export function getPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source
  for (const segment of path) {
    if (!isRecord(current))
      return undefined
    current = current[segment]
  }
  return current
}

export function parseProfilePath(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0)
    return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed))
      return []
    return parsed.filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
  }
  catch {
    return []
  }
}

export function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim().length === 0)
    return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed))
      return undefined
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      const trimmed = name.trim()
      if (trimmed.length > 0 && typeof value === 'string')
        headers[trimmed] = value
    }
    return Object.keys(headers).length === 0 ? undefined : headers
  }
  catch {
    return undefined
  }
}

export function listingHeaders(apiKey: string | undefined, headers: Record<string, string> | undefined): Record<string, string> {
  const owned: Record<string, string> = apiKey === undefined
    ? { accept: 'application/json' }
    : { accept: 'application/json', authorization: `Bearer ${apiKey}` }
  const reserved = new Set(Object.keys(owned).map(name => name.toLowerCase()))
  const kept = Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))
  return { ...Object.fromEntries(kept), ...owned }
}

export function apiKeyRefOf(profile: unknown): string | undefined {
  return nonEmptyText(isRecord(profile) ? profile.apiKeyEnv : undefined)
}

export function endpointOf(profile: unknown, override: string | undefined): string | undefined {
  const trimmedOverride = override?.trim()
  if (trimmedOverride !== undefined && trimmedOverride.length > 0)
    return trimmedOverride
  return nonEmptyText(isRecord(profile) ? profile.baseURL : undefined)
}

export function modelsListingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}
