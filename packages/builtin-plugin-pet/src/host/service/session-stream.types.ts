import type { PetToolActivity, PetWorkStatus } from '../types'

/**
 * 最小会话增量事件（与 `@deepseek-ai/dsh-session` 的
 * `SessionEvent = { type, seq, time, data }` 契约对齐）。
 *
 * 故意做成本地类型而非从 dsh-session 导入：本插件未直接依赖该包，
 * 且把「运行时可能携带的额外字段」隔离，reducer 只消费声明的最小字段。
 */
export interface PetSessionEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  /**
   * 事件的表面（surface）标记：`'append'` 表示正常追加到会话表面，
   * `{ op: 'replace', startSeq, endSeq }` 表示该事件只是替换既有事件区间的**记账标记**，
   * 本身不开启新回合（如 rewind 回退、压缩 checkpoint）。
   */
  surfaceOp?: 'append' | { op?: string, startSeq?: number, endSeq?: number }
}

/** goal 自动续跑轮的收尾动作（`update_goal` 的 action）。 */
export type PetGoalClosing = 'complete' | 'blocked'

/** 从真实 session 对象上读取的最小输入（与运行时形状解耦）。 */
export interface PetSessionPeer {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running?: boolean
}

/** 每个会话的全量累计态；fold 出展示 payload 后与 lastSent 深比较去重。 */
export interface PetSessionState {
  id: string
  origin?: 'subagent'
  title?: string
  displayTitle?: string
  cwd?: string
  running: boolean
  turnActive: boolean
  stepActive: boolean
  openTools: Map<string, { name: string, args?: string }>
  /** 累计的 reasoning 文本（滚动尾部窗口）。 */
  reasoningTail: string
  /** 最近一条助手普通文本（用于 message）。 */
  assistantText: string
  lastAgentError?: string
  waitingKind?: 'approval' | 'user-question' | 'blocked'
  /** 当前待审批的 approval 请求 id。 */
  waitingApprovalId?: string
  /** 当前「等用户回答」的问句工具调用 id。 */
  waitingCallId?: string
  workStatus?: PetWorkStatus
  /** 本回合是否为 goal 自动续跑轮（`user/message` 的 `source.kind==='goal'` 且 `round>0`）。 */
  goalRound?: boolean
  /** 本回合内 `update_goal` 声明的收尾动作；未声明 = 目标仍在推进。 */
  goalClosing?: PetGoalClosing
  /** 当前任务文本（todo/write 的 in_progress/pending 项 content）。 */
  task?: string
  /** 当前工具活动分类（最近一次 working 工具名分类）。 */
  toolActivity?: PetToolActivity
}

/** 宿主 `sessionTitle` 服务的读取面（可选：未挂载时回退 id）。 */
export interface TitleServiceLike {
  get?: (session: unknown) => { title?: string } | undefined
}

/** 会话投影注册表：`@deepseek-ai/dsh-session-title` 注册了 key='title' 的投影单元。 */
export interface ProjectionRegistryLike {
  stateOf?: (session: unknown, key: string) => unknown
}
