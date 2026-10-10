/**
 * apis/index.ts — 客户端 RPC/HTTP 层：全局 fetch（ofetch 统一 JSON 客户端）。
 *
 * 唯一导出 `fetch`：ofetch 负责 URL 拼接、JSON 解析（parseResponse 优先解码，
 * 旧宿主/未注册路由返回的纯文本错误体原样保留）、超时（timeout 选项）与
 * 重试（默认关）。错误归一（非 2xx → 可展示 Error，取响应体 error 字段）内置
 * 在此，调用方无需关心错误格式、无需自封装 requestJson/createJsonClient。
 */

import type { FetchOptions as OfetchOptions } from 'ofetch'
import { createFetch } from 'ofetch'
import { defaultErrorMessage, parseJsonResponse } from './index.utils'

/** 实例的选项类型：JSON 解码路径（与 `ofetch` 实例签名一致，供生成客户端直接引用）。 */
export type FetchOptions = OfetchOptions<'json'>

/** 全局 JSON fetch：同源 API 请求唯一入口（错误解析统一在此）。 */
export const fetch = createFetch({
  defaults: {
    retry: 0,
    parseResponse: parseJsonResponse,
    onResponseError: ({ response }) => {
      throw Object.assign(new Error(defaultErrorMessage(response.status, response._data)), { status: response.status })
    },
  },
})

/** 同一实例的别名：genapi 的 ofetch 预设按 `ofetch` 标识符生成调用。 */
export const ofetch = fetch
