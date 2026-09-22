import type { EndpointModelCard } from '../routes/index.types'
import { defineService } from 'dsh-tauri'
import { getCurrentHostInstance } from '../config/runtime'
import {
  apiKeyRefOf,
  endpointOf,
  getPath,
  listingHeaders,
  modelsListingUrl,
  normalizeEndpointModels,
  parseProfilePath,
} from './endpoint-models.utils'

export interface EndpointModelsInput {
  /** 承载该提供方配置的设置命名空间。 */
  ns: string
  /** 从命名空间节根到 profile 的路径，JSON 数组字符串（空/缺省表示整节即 profile）。 */
  profilePath?: string
  /** 表单当前显示的 API 地址；为空时用 profile 里已保存的值。 */
  baseURL?: string
  /** 已输入但尚未保存的密钥；为空时用 profile 指向的已存凭证。 */
  apiKey?: string
  /** 表单当前的自定义请求头，JSON 对象。缺省时用 profile 里已保存的 `headers`。 */
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

/** 凭据只在宿主侧解析，响应里从不回显；表单里刚输入的密钥优先。 */
async function resolveApiKey(ref: string | undefined, typed: string | undefined): Promise<string | undefined> {
  const trimmed = typed?.trim()
  if (trimmed !== undefined && trimmed.length > 0)
    return trimmed
  if (ref === undefined)
    return undefined
  try {
    const credentials = getCurrentHostInstance().get('credentials') as CredentialsService | undefined
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
 * 直接读取提供方端点公布的模型清单。
 *
 * 官方发现通道会把清单收窄成它自己的模型模型，而宿主直连能拿到端点写下的原始容量字段
 * （`context_length` / `max_output_tokens` 等一批别名）——这是本服务存在的唯一理由，
 * 与参考实现 dsh-llm-capabilities 的 `raw-models` 路由同理。
 */
export const endpointModels = defineService({
  /**
   * 读取 `{baseURL}/models` 并归一化。
   * @param input - 设置命名空间、profile 路径，以及表单当前显示的可选覆盖值。
   * @returns 归一化条目与清单地址，或宿主侧自己的失败文案。
   */
  async list(input: EndpointModelsInput): Promise<EndpointModelsResult> {
    const settings = getCurrentHostInstance().get('settings') as SettingsService | undefined
    const section = settings?.get(input.ns)
    const path = parseProfilePath(input.profilePath)
    const profile = path.length === 0 ? section : getPath(section, path)
    const baseURL = endpointOf(profile, input.baseURL)
    if (baseURL === undefined) {
      return { ok: false, error: `settings namespace "${input.ns}" names no endpoint to read` }
    }
    const url = modelsListingUrl(baseURL)
    const apiKey = await resolveApiKey(apiKeyRefOf(profile), input.apiKey)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: listingHeaders(profile, input.headers, apiKey),
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
