export interface EndpointModelCard {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface GetEndpointModelsQuery {
  ns?: string
  profilePath?: string
  baseURL?: string
  apiKey?: string
  headers?: string
}

export interface EndpointModelsResponse {
  ok?: boolean
  url?: string
  models?: EndpointModelCard[]
  error?: string
}

export interface OpenModelsConfigResponse {
  ok?: boolean
  path?: string
  opened?: 'file' | 'directory'
  error?: string
}

export interface GetPresetsQuery {
  force?: string
}

export interface PresetsResponse {
  ok?: boolean
  source?: string
  fetchedAt?: string
  stale?: boolean
  count?: number
  presets?: Record<string, readonly number[]>
  error?: string
}
