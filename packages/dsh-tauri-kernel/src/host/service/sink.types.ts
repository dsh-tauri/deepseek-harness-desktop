import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NativeContent, NativeSink } from '../backends/types'
import type { NativeExecution } from '../types'

export interface StreamTrack {
  blocks: { index: number, type: 'text' | 'reasoning' }[]
  deltaSlots: Map<'text' | 'reasoning', number>
  segment: number
  content?: readonly NativeContent[]
}

export interface NativeToolResult {
  output: string
  isError: boolean
}

export interface ToolTrack {
  name: string
  arguments: string
  started: boolean
  dispatched: boolean
  step?: number
  accepted: boolean
  committed: boolean
  result?: NativeToolResult
  wait: Promise<NativeToolResult>
  resolve: (result: NativeToolResult) => void
  reject: (error: unknown) => void
}

export interface SinkState {
  input: NativeExecution
  native: NativeSink
  controller: AbortController
  signal: AbortSignal
  streams: Map<string, StreamTrack>
  assistants: Map<string, string>
  tools: Map<string, ToolTrack>
  registrations: Map<string, () => void | Promise<void>>
  restoreMode: () => void | Promise<void>
  queue: StreamChunk[]
  queuedBytes: number
  outputBytes: number
  segment: number
  nextIndex: number
  lastStep: number
  active: boolean
  done: boolean
  finalConsumed: boolean
  failure?: unknown
  wake?: () => void
  task?: Promise<void>
  disposal?: Promise<void>
}

export interface OfficialSink {
  state: SinkState
  settle: (error?: unknown) => void
  dispose: () => Promise<void>
}
