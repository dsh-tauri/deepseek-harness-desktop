export type PostApiDesktopDshTauriModelConfigOpenResponse = { ok?: undefined | false | true; path?: undefined | string; opened?: undefined | "file" | "directory"; error?: undefined | string };
export type PostApiDesktopDshTauriModelConfigOpenQueryDry = undefined | string;
export type GetApiDesktopDshTauriModelEndpointModelsResponse = { ok?: undefined | false | true; url?: undefined | string; models?: undefined | { id: string; name?: undefined | string; contextWindow?: undefined | number; maxTokens?: undefined | number }[]; error?: undefined | string };
export type GetApiDesktopDshTauriModelEndpointModelsQueryNs = undefined | string;
export type GetApiDesktopDshTauriModelEndpointModelsQueryProfilePath = undefined | string;
export type GetApiDesktopDshTauriModelEndpointModelsQueryBaseURL = undefined | string;
export type GetApiDesktopDshTauriModelEndpointModelsQueryApiKey = undefined | string;
export type GetApiDesktopDshTauriModelEndpointModelsQueryHeaders = undefined | string;
export type GetApiDesktopDshTauriModelPresetsResponse = { ok?: undefined | false | true; source?: undefined | string; fetchedAt?: undefined | string; stale?: undefined | false | true; count?: undefined | number; presets?: undefined | { [key: string]: number[] }; error?: undefined | string };
export type GetApiDesktopDshTauriModelPresetsQueryForce = undefined | string;

export interface PostApiDesktopDshTauriModelConfigOpenQuery {
  dry?: PostApiDesktopDshTauriModelConfigOpenQueryDry;
}
export interface GetApiDesktopDshTauriModelEndpointModelsQuery {
  ns?: GetApiDesktopDshTauriModelEndpointModelsQueryNs;
  profilePath?: GetApiDesktopDshTauriModelEndpointModelsQueryProfilePath;
  baseURL?: GetApiDesktopDshTauriModelEndpointModelsQueryBaseURL;
  apiKey?: GetApiDesktopDshTauriModelEndpointModelsQueryApiKey;
  headers?: GetApiDesktopDshTauriModelEndpointModelsQueryHeaders;
}
export interface GetApiDesktopDshTauriModelPresetsQuery {
  force?: GetApiDesktopDshTauriModelPresetsQueryForce;
}
