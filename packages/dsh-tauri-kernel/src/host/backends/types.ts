import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'

export type { NativeModelCatalog, NativeModelInfo, NativeTurnOptions } from '../../shared/native-model'

export interface NativeSessionOpenOptions {
  forkFrom?: string
}

export interface NativeCommand {
  file: string
  args: string[]
  env?: Record<string, string | undefined>
}

export type NativeContent
  = | { type: 'text', text: string }
    | { type: 'thinking', text: string }
    | { type: 'tool-call', id: string, name: string, arguments: string }

export interface NativeQuestion {
  id: string
  question: string
  options?: { label: string, description?: string }[]
  multiSelect?: boolean
}

export interface NativeSink {
  text: (id: string, delta: string) => void
  thinking: (id: string, delta: string) => void
  assistant: (id: string, content: readonly NativeContent[]) => void
  toolStart: (id: string, name: string, arguments_: string) => void
  toolEnd: (id: string, output: string, error?: boolean) => void
  approval: (
    id: string,
    request: { kind: 'command' | 'file' | 'tool', title: string, details: string },
    signal?: AbortSignal,
  ) => Promise<boolean>
  questions: (id: string, questions: NativeQuestion[], signal?: AbortSignal) => Promise<Record<string, string | string[]>>
}

export interface NativeSession {
  readonly id: string
  models?: (signal: AbortSignal) => Promise<NativeModelCatalog>
  submit: (messages: readonly UserMessage[], signal: AbortSignal, options?: NativeTurnOptions) => Promise<void>
  dispose: () => Promise<void>
}
