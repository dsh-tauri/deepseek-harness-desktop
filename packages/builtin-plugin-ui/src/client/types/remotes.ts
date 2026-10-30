export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface RemoteFailure {
  code: string
  message: string
}

export type RemoteResult<T>
  = | { ok: true, value: T }
    | { ok: false, error: RemoteFailure }

export interface LlmModelDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

export interface LlmDiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}
