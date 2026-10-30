import type { LlmDiscoveredModel } from '../types/remotes.ts'
import { getEndpointModels, postConfigOpen } from '../apis'

export interface EndpointProbe {
  settingsNs: string
  profilePath: readonly string[]
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
}

export type ModelCapacityFetch
  = | { ok: true, models: readonly LlmDiscoveredModel[] }
    | { ok: false, error: string }

export type ConfigFileOpen
  = | { ok: true, path: string, opened: 'file' | 'directory' }
    | { ok: false, error: string }

export type ModelDiscoveryOutcome
  = | { readonly kind: 'found', readonly models: readonly LlmDiscoveredModel[] }
    | { readonly kind: 'refused', readonly message: string }

export interface ModelDiscoveryChannel {
  discoverModels: (settingsNs: string, request: { provider?: string, baseURL?: string, api?: string, apiKey?: string }) => Promise<ModelDiscoveryOutcome>
}

async function fetchEndpointModels(probe: EndpointProbe): Promise<ModelCapacityFetch> {
  try {
    const response = await getEndpointModels({
      ns: probe.settingsNs,
      profilePath: JSON.stringify([...probe.profilePath]),
      ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
      ...probe.apiKey === undefined || probe.apiKey.length === 0 ? {} : { apiKey: probe.apiKey },
      ...probe.headers === undefined || Object.keys(probe.headers).length === 0
        ? {}
        : { headers: JSON.stringify(probe.headers) },
    })
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    return { ok: true, models: response.models ?? [] }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadModelCapacities(
  probe: EndpointProbe,
  operations?: ModelDiscoveryChannel,
): Promise<ModelCapacityFetch> {
  const direct = await fetchEndpointModels(probe)
  if (direct.ok && direct.models.length > 0)
    return direct
  if (operations === undefined)
    return direct
  const official = await operations.discoverModels(probe.settingsNs, {
    ...probe.provider === undefined ? {} : { provider: probe.provider },
    ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
    ...probe.api === undefined ? {} : { api: probe.api },
    ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
  })
  if (official.kind === 'found' && official.models.length > 0)
    return { ok: true, models: official.models }
  if (!direct.ok)
    return { ok: false, error: direct.error }
  return {
    ok: false,
    error: official.kind === 'refused' ? official.message : 'the endpoint disclosed no models',
  }
}

export async function openConfigFile(): Promise<ConfigFileOpen> {
  try {
    const response = await postConfigOpen(undefined, { ignoreResponseError: true })
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    return { ok: true, path: response.path ?? '', opened: response.opened ?? 'file' }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
