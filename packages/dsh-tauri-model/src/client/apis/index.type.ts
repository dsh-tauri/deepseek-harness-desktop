export type OpenModelsConfigResponse = {
  ok?: boolean;
  path?: string;
  opened?: "file" | "directory";
  error?: string;
};
export type EndpointModelsResponse = {
  ok?: boolean;
  url?: string;
  models?: EndpointModelCard[];
  error?: string;
};
export type EndpointModelCard = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
};
export type PresetsResponse = {
  ok?: boolean;
  source?: string;
  fetchedAt?: string;
  stale?: boolean;
  count?: number;
  presets?: Record<string, readonly number[]>;
  error?: string;
};

export interface GetEndpointModelsQuery {
  ns?: string;
  profilePath?: string;
  baseURL?: string;
  apiKey?: string;
  headers?: string;
}
export interface GetPresetsQuery {
  force?: string;
}
