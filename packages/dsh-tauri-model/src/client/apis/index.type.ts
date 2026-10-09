export type PostApiTauriModelConfigOpenResponse = { ok?: undefined | false | true; path?: undefined | string; opened?: undefined | "file" | "directory"; error?: undefined | string };
export type PostApiTauriModelConfigOpenQueryDry = undefined | string;
export type GetApiTauriModelEndpointModelsResponse = { ok?: undefined | false | true; url?: undefined | string; models?: undefined | { id: string; name?: undefined | string; contextWindow?: undefined | number; maxTokens?: undefined | number }[]; error?: undefined | string };
export type GetApiTauriModelEndpointModelsQueryNs = undefined | string;
export type GetApiTauriModelEndpointModelsQueryProfilePath = undefined | string;
export type GetApiTauriModelEndpointModelsQueryBaseURL = undefined | string;
export type GetApiTauriModelEndpointModelsQueryApiKey = undefined | string;
export type GetApiTauriModelEndpointModelsQueryHeaders = undefined | string;
export type GetApiTauriModelPresetsResponse = { ok?: undefined | false | true; source?: undefined | string; fetchedAt?: undefined | string; stale?: undefined | false | true; count?: undefined | number; presets?: undefined | { [key: string]: number[] }; error?: undefined | string };
export type GetApiTauriModelPresetsQueryForce = undefined | string;

export interface PostApiTauriModelConfigOpenQuery {
  dry?: PostApiTauriModelConfigOpenQueryDry;
}
export interface GetApiTauriModelEndpointModelsQuery {
  ns?: GetApiTauriModelEndpointModelsQueryNs;
  profilePath?: GetApiTauriModelEndpointModelsQueryProfilePath;
  baseURL?: GetApiTauriModelEndpointModelsQueryBaseURL;
  apiKey?: GetApiTauriModelEndpointModelsQueryApiKey;
  headers?: GetApiTauriModelEndpointModelsQueryHeaders;
}
export interface GetApiTauriModelPresetsQuery {
  force?: GetApiTauriModelPresetsQueryForce;
}
