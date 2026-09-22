import type { EndpointModelCard } from '../routes/index.types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 首个可用作容量的正整数；非正整数与缺省一律视为「未披露」。 */
function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
      return value
  }
  return undefined
}

function nonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0)
      return value
  }
  return undefined
}

function nested(source: Record<string, unknown> | undefined, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

/**
 * 把一条端点清单纪录收敛成模型条目。
 *
 * 容量字段取自各家 OpenAI 兼容实现的常见别名（官方发现通道读的是同一批），
 * 端点没披露就留空，绝不臆测。
 * @param value - 清单里的一条纪录。
 * @returns 归一化条目；没有可用 id 时返回 undefined。
 */
export function normalizeEndpointModel(value: unknown): EndpointModelCard | undefined {
  if (!isRecord(value))
    return undefined
  const id = nonEmptyText(value.id)
  if (id === undefined)
    return undefined
  const limit = isRecord(value.limit) ? value.limit : undefined
  const topProvider = isRecord(value.top_provider) ? value.top_provider : undefined
  const contextWindow = positiveInteger(
    value.contextWindow,
    value.context_window,
    value.context_length,
    value.max_input_tokens,
    value.max_model_len,
    nested(limit, 'context'),
  )
  const maxTokens = positiveInteger(
    value.maxOutputTokens,
    value.max_output_tokens,
    value.maxTokens,
    value.max_tokens,
    value.max_output_length,
    nested(limit, 'output'),
    nested(topProvider, 'max_completion_tokens'),
  )
  const name = nonEmptyText(value.name)
  return {
    id,
    ...name === undefined ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

/** 读取 `{ data: [...] }` 清单信封里的每一条纪录。 */
export function normalizeEndpointModels(payload: unknown): EndpointModelCard[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data))
    return undefined
  const cards: EndpointModelCard[] = []
  for (const entry of payload.data) {
    const card = normalizeEndpointModel(entry)
    if (card !== undefined)
      cards.push(card)
  }
  return cards
}

/** 按路径读取设置节里的一个节点；任一段缺失即返回 undefined。 */
export function getPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source
  for (const segment of path) {
    if (!isRecord(current))
      return undefined
    current = current[segment]
  }
  return current
}

/** 解析查询里的 profile 路径：非法 JSON 或非字符串数组都按「整节即 profile」处理。 */
export function parseProfilePath(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0)
    return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed))
      return []
    return parsed.filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
  }
  catch {
    return []
  }
}

/** profile 里指向凭据的引用名。 */
export function apiKeyRefOf(profile: unknown): string | undefined {
  return nonEmptyText(isRecord(profile) ? profile.apiKeyEnv : undefined)
}

/** profile 里已保存的 API 地址，或表单当前显示的那个。 */
export function endpointOf(profile: unknown, override: string | undefined): string | undefined {
  const trimmedOverride = override?.trim()
  if (trimmedOverride !== undefined && trimmedOverride.length > 0)
    return trimmedOverride
  return nonEmptyText(isRecord(profile) ? profile.baseURL : undefined)
}

/** 清单地址：`{baseURL}/models`。 */
export function modelsListingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

function stringHeaders(source: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string')
      headers[name] = value
  }
  return headers
}

function storedHeaders(profile: unknown): Record<string, string> {
  if (!isRecord(profile) || !isRecord(profile.headers))
    return {}
  return stringHeaders(profile.headers)
}

/** 表单带来的头。缺省或不是对象时返回 undefined，调用方改读 profile。 */
function headerOverride(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim().length === 0)
    return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed))
      return undefined
    return stringHeaders(parsed)
  }
  catch {
    return undefined
  }
}

/**
 * 清单请求的头。
 *
 * 表单当前值盖过 profile 里已保存的头。随后强制 `accept`，有密钥时再强制 `authorization`，
 * 避免自定义头把清单本身改成非 JSON，或盖掉这次解析出来的密钥。非法条目跳过，不让整次读取变成网络错误。
 */
export function listingHeaders(profile: unknown, overrideRaw: string | undefined, apiKey: string | undefined): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(headerOverride(overrideRaw) ?? storedHeaders(profile))) {
    try {
      headers.set(name, value)
    }
    catch (error) {
      if (!(error instanceof TypeError))
        throw error
    }
  }
  headers.set('accept', 'application/json')
  if (apiKey !== undefined)
    headers.set('authorization', `Bearer ${apiKey}`)
  return headers
}
