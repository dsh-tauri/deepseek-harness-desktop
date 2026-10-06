import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** 遮蔽区间写入意图：内核要求 `sourceEventSeqs` 完整覆盖被遮蔽节点。 */
export interface SurfaceReplaceIntent {
  surfaceOp: { op: 'replace', startSeq: number, endSeq: number }
  sourceEventSeqs: readonly number[]
}

/**
 * 宿主侧会话面：只声明本插件真正调用的成员。
 *
 * `surface.nodes` 与带意图的 `append` 是内容审核恢复的前提——内核 `Session` 逐版本
 * 漂移，故此处按能力探测，缺失时恢复路径必须退化为明确的人工提示。
 */
export interface PlanSession {
  snapshotEvents?: () => readonly unknown[]
  surface?: { nodes?: readonly number[] }
  append: {
    (type: 'todo/write', data: { todos: readonly unknown[] }): unknown
    (type: 'user/message', data: unknown, intent: SurfaceReplaceIntent): unknown
  }
}

export type CreateUserMessage = (input: {
  content: readonly { type: 'text', text: string }[]
  source: unknown
}) => UserMessage
