import type { RemoteSourceClass } from '../types/index'

export type RemoteContentCoding = 'zstd' | 'gzip'

/** 转发请求的改写与注入计划：authority 对齐 + 内部来源标识 + 出站腿的 identity 声明。 */
export interface RemoteForwardPlan {
  authority: string
  source?: RemoteSourceClass
  session?: string
  identity?: boolean
  upgrade?: boolean
}

/** 响应体处理计划：是否先解压、是否重压、是否逐块流式、是否按阈值缓冲决策（S2 §8.2/§8.3）。 */
export interface RemoteResponsePlan {
  decode?: string
  coding?: RemoteContentCoding
  streaming: boolean
  buffered: boolean
}

export interface RemoteResponsePlanInput {
  acceptEncoding: string | undefined
  contentType: string | undefined
  contentLength: number | undefined
  upstreamEncoding: string | undefined
  supportsZstd: boolean
  /** 下游为物理回环时一律 identity（S2 §8.1 的「本地回环腿」）。 */
  compress: boolean
  /** 小于该体积不压缩；SSE 不受此限。 */
  minBytes: number
}
