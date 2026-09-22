import type { ModelsOperations } from '../models/operations.ts'
import type { LlmDiscoveredModel } from '../types/remotes.ts'
import { getEndpointModels, postConfigOpen } from '../apis'

/** 一次读取所要问的端点事实：设置地址 + 表单当前显示的值。 */
export interface EndpointProbe {
  settingsNs: string
  profilePath: readonly string[]
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
  /** 表单当前的自定义请求头。传入后盖过 profile 里已保存的头，空对象表示这次不带头。 */
  headers?: Record<string, string>
}

export type ModelCapacityFetch
  = | { ok: true, models: readonly LlmDiscoveredModel[] }
    | { ok: false, error: string }

export type ConfigFileOpen
  = | { ok: true, path: string, opened: 'file' | 'directory' }
    | { ok: false, error: string }

/** 直接读提供方端点公布的清单；能带回官方通道裁掉的容量字段。 */
async function fetchEndpointModels(probe: EndpointProbe): Promise<ModelCapacityFetch> {
  try {
    const response = await getEndpointModels({
      ns: probe.settingsNs,
      profilePath: JSON.stringify([...probe.profilePath]),
      ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
      ...probe.apiKey === undefined || probe.apiKey.length === 0 ? {} : { apiKey: probe.apiKey },
      ...probe.headers === undefined ? {} : { headers: JSON.stringify(probe.headers) },
    })
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    return { ok: true, models: response.models ?? [] }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读取端点公布的模型容量：先宿主直连原始清单，失败再退回官方发现通道。
 *
 * 两条通道各有覆盖不到的地方——自建端点的容量只在端点自己写下的原始字段里，而官方通道认识
 * 端点地址不在用户设置里的提供方（例如内置的 DeepSeek 官方路由）。先直连再回退，与参考实现
 * dsh-llm-capabilities 的顺序一致。
 * @param probe - 表单当前显示的端点事实。
 * @param operations - 官方发现通道。
 * @returns 归一化条目，或两条通道都没成功时的失败文案。
 */
export async function loadModelCapacities(
  probe: EndpointProbe,
  operations: ModelsOperations,
): Promise<ModelCapacityFetch> {
  const direct = await fetchEndpointModels(probe)
  if (direct.ok && direct.models.length > 0)
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
    const response = await postConfigOpen({ ignoreResponseError: true })
    if (response.error !== undefined)
      return { ok: false, error: response.error }
    return { ok: true, path: response.path ?? '', opened: response.opened ?? 'file' }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
