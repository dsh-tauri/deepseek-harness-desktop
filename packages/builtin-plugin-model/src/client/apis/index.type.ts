export interface PostApiTauriModelConfigOpenResponse { ok?: undefined | false | true, path?: undefined | string, opened?: undefined | 'file' | 'directory', error?: undefined | string }
export type PostApiTauriModelConfigOpenQueryDry = undefined | string
export interface GetApiTauriModelEndpointModelsResponse { ok?: undefined | false | true, url?: undefined | string, models?: undefined | { id: string, name?: undefined | string, contextWindow?: undefined | number, maxTokens?: undefined | number }[], error?: undefined | string }
export type GetApiTauriModelEndpointModelsQueryNs = undefined | string
export type GetApiTauriModelEndpointModelsQueryProfilePath = undefined | string
export type GetApiTauriModelEndpointModelsQueryBaseURL = undefined | string
export type GetApiTauriModelEndpointModelsQueryApiKey = undefined | string
export type GetApiTauriModelEndpointModelsQueryHeaders = undefined | string
export interface GetApiTauriModelPresetsResponse { ok?: undefined | false | true, source?: undefined | 'pi-ai' | 'litellm' | 'merged', fetchedAt?: undefined | string, stale?: undefined | false | true, count?: undefined | number, presets?: undefined | Record<string, { provider?: undefined | string, id?: undefined | string, api?: undefined | string, input?: undefined | string[], reasoning?: undefined | false | true, reasoningEfforts?: undefined | false | Record<string, null | string>, contextWindow?: undefined | number, maxTokens?: undefined | number }>, error?: undefined | string }
export type GetApiTauriModelPresetsQueryForce = undefined | string

export interface PostApiTauriModelConfigOpenQuery {
  dry?: PostApiTauriModelConfigOpenQueryDry
}
export interface GetApiTauriModelEndpointModelsQuery {
  ns?: GetApiTauriModelEndpointModelsQueryNs
  profilePath?: GetApiTauriModelEndpointModelsQueryProfilePath
  baseURL?: GetApiTauriModelEndpointModelsQueryBaseURL
  apiKey?: GetApiTauriModelEndpointModelsQueryApiKey
  headers?: GetApiTauriModelEndpointModelsQueryHeaders
}
export interface GetApiTauriModelPresetsQuery {
  force?: GetApiTauriModelPresetsQueryForce
}
