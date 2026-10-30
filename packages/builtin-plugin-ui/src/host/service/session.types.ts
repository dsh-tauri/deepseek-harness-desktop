import type { UserMessage } from '@deepseek-ai/dsh-llm'

export interface SurfaceReplaceIntent {
  surfaceOp: { op: 'replace', startSeq: number, endSeq: number }
  sourceEventSeqs: readonly number[]
}

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
