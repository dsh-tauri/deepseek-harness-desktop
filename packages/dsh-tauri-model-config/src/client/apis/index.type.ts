export type EditorPreferenceResponse = {
  preference?: EditorPreference;
  error?: string;
};
export type EditorPreference = {
  editor: "vscode" | "cursor" | "system" | "custom";
  command: string;
};
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
  /** 上游不可达、回退到过期缓存时为 true。 */
  stale?: boolean;
  count?: number;
  presets?: Record<string, readonly number[]>;
  error?: string;
};

export interface EditorPreferenceBody {
  preference: EditorPreference;
}
export interface GetEndpointModelsQuery {
  ns?: string;
  profilePath?: string;
  baseURL?: string;
  apiKey?: string;
  /** 表单当前的自定义请求头（JSON 对象）。缺省时用 profile 里已保存的 headers。 */
  headers?: string;
}
export interface GetPresetsQuery {
  force?: string;
}
