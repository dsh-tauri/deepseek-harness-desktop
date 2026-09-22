import type { EditorPreference } from '../../shared/editor.types'

export interface EditorPreferenceBody {
  preference: EditorPreference
}

export interface EditorPreferenceResponse {
  preference?: EditorPreference
  error?: string
}

export type HostContext = any

/** 一条归一化后的端点模型条目；缺席字段表示端点没有披露。 */
export interface EndpointModelCard {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface GetEndpointModelsQuery {
  /** 承载该提供方配置的设置命名空间（`llm-pi-ai` / `llm-deepseek` …）。 */
  ns?: string
  /** 从命名空间节根到该提供方 profile 的路径（JSON 数组；空数组表示整节即 profile）。 */
  profilePath?: string
  /** 表单当前显示的 API 地址；为空时用 profile 里已保存的值。 */
  baseURL?: string
  /** 已输入但尚未保存的密钥；为空时用 profile 指向的已存凭证。 */
  apiKey?: string
  /** 表单当前的自定义请求头（JSON 对象）。缺省时用 profile 里已保存的 `headers`。 */
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
  /** `'true'` 表示忽略缓存有效期，重新下载预设表。 */
  force?: string
}

export interface PresetsResponse {
  ok?: boolean
  source?: string
  fetchedAt?: string
  /** 上游不可达、回退到过期缓存时为 true。 */
  stale?: boolean
  count?: number
  presets?: Record<string, readonly number[]>
  error?: string
}
