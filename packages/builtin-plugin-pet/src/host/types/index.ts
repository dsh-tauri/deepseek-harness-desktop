/**
 * host/types/index.ts — 跨模块共享的桌宠会话流契约（service 产出、routes 消费）。
 *
 * 工作状态细分档位（对齐 dsh-pet 的 6 档枚举；索引 = config.jsonc
 * animations.events.workStatus 数组索引，勿在中间插入新档）取代旧「粗档 status」，
 * 成为会话气泡与动画的权威驱动：
 *   thinking（回合内思考）→ working（tool/call）→ result（tool/result 后整理）
 *   → waiting（approval/问句工具/blocked）→ success（completed，终态档）/ error（终态档）。
 */

/** 细分工作状态档位。 */
export type PetWorkStatus = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'

/** 工具活动分类：气泡按分类选文案。 */
export type PetToolActivity = 'searching' | 'editing' | 'testing' | 'commanding' | 'using-tool'

/** 桌宠展示态的字段子集（SSE 帧载荷）。 */
export interface PetSessionPayload {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  name?: string
  description?: string
  message?: string
  status?: string
  activity?: string
  phase?: string
  running?: boolean
  pendingInteraction?: unknown
  pending?: readonly unknown[]
  lastAgentError?: string
  workStatus?: PetWorkStatus
  task?: string
  toolActivity?: PetToolActivity
  liveActivity?: {
    kind: string
    text?: string
    name?: string
    command?: string
    path?: string
    args?: string
  }
}

/**
 * 单个 SSE 消费者。
 *
 * 只暴露「推一帧 data 载荷」与「结束连接」两个动作：不接触 h3 事件、响应对象或请求体，
 * 因此会话总线的投影逻辑可以脱离 HTTP 单测。
 */
export interface SessionStreamSink {
  /** 推送一帧 `data:` 载荷（JSON 字符串）。 */
  push: (frame: string) => void
  /** 结束该连接（断连、插件卸载或写失败时的收尾）。 */
  close: () => void
}
