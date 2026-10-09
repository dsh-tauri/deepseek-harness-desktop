import type { EndpointModelCard } from '../server/routes/index.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { server } from '../server'
import {
  apiKeyRefOf,
  endpointOf,
  getPath,
  listingHeaders,
  modelsListingUrl,
  normalizeEndpointModels,
  parseHeaders,
  parseProfilePath,
} from './endpoint-models.utils'

export interface EndpointModelsInput {
  ns: string
  profilePath?: string
  baseURL?: string
  apiKey?: string
  headers?: string
}

export type EndpointModelsResult
  = | { ok: true, url: string, models: EndpointModelCard[] }
    | { ok: false, error: string }

const FETCH_TIMEOUT_MS = 15_000

interface SettingsService {
  get: (ns: string) => unknown
}

interface CredentialsService {
  resolve: (ref: string) => Promise<{ value?: string } | undefined>
}

async function resolveApiKey(ref: string | undefined, typed: string | undefined): Promise<string | undefined> {
  const trimmed = typed?.trim()
  if (trimmed !== undefined && trimmed.length > 0)
    return trimmed
  if (ref === undefined)
    return undefined
  try {
    const credentials = getServerContext(server).get('credentials') as CredentialsService | undefined
    if (credentials === undefined)
      return undefined
    const hit = await credentials.resolve(ref)
    return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 读取设置命名空间。两代内核的 `settings.get` 严格程度不同：0.1.7 对未知命名空间会抛，
 * 而本路由的契约是「没有 endpoint 就 502」，所以这里必须把查找失败归一成 `undefined`。
 */
function readSection(ns: string): unknown {
  try {
    const settings = getServerContext(server).get('settings') as SettingsService | undefined
    return settings?.get(ns)
  }
  catch {
    return undefined
  }
}

export const endpointModels = defineService({
  async list(input: EndpointModelsInput): Promise<EndpointModelsResult> {
    const section = readSection(input.ns)
    const path = parseProfilePath(input.profilePath)
    const profile = path.length === 0 ? section : getPath(section, path)
    const baseURL = endpointOf(profile, input.baseURL)
    if (baseURL === undefined) {
      return { ok: false, error: `settings namespace "${input.ns}" names no endpoint to read` }
    }
    const url = modelsListingUrl(baseURL)
    const apiKey = await resolveApiKey(apiKeyRefOf(profile), input.apiKey)
    const headers = listingHeaders(apiKey, parseHeaders(input.headers))
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? '; check the API key' : ''
        return { ok: false, error: `${url} answered ${response.status}${hint}` }
      }
      const models = normalizeEndpointModels(await response.json())
      if (models === undefined)
        return { ok: false, error: `${url} model listing has no "data" array` }
      return { ok: true, url, models }
    }
    catch (error) {
      return { ok: false, error: `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
})
