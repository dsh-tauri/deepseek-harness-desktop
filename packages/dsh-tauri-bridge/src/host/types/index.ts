import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import type * as LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace'
import type { HostContext as DesktopHostContext } from 'dsh-tauri'
import type { NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { NativeSession } from '../backends/types'
import type { KERNEL_RECORD_TYPE, MODEL_RECORD_TYPE } from '../config/constants'

export interface PlatformLoader {
  import: (id: string) => Promise<unknown>
  unwrapExports: (value: unknown) => unknown
}

export interface RuntimeModules {
  ToolCallId: typeof LlmRuntime.ToolCallId
  HarnessError: typeof LlmRuntime.HarnessError
  LlmAdapter: typeof LlmRuntime.LlmAdapter
  isAgentLoopRequest: typeof LlmRuntime.isAgentLoopRequest
  appendPluginRecord?: (session: Session, type: 'plugin:dsh-tauri-bridge/kernel' | 'plugin:dsh-tauri-bridge/model', data: KernelBinding | NativeTurnOptions) => number
  pluginRecordOf?: (event: SessionEvent) => { type: string, data: unknown } | undefined
}

export interface AdmittedStep {
  agent: Agent
  turn: number
  step: number
  messages: readonly UserMessage[]
  signal: AbortSignal
  request?: GenerateOptions
  dispatched: boolean
}

export interface NativeExecution extends AdmittedStep {
  binding: KernelBinding
  options?: NativeTurnOptions
}

export type HostContext = DesktopHostContext & {
  loader: DesktopHostContext['loader'] & PlatformLoader
}

export type BridgeRecordType = typeof KERNEL_RECORD_TYPE | typeof MODEL_RECORD_TYPE

export interface RecordWatermark {
  readonly type: BridgeRecordType
  readonly seq: number
  readonly encodedData: string
}

export interface BridgeCheckpointState {
  readonly ownerSessionId: string
  readonly inheritedEventCount: number
  readonly binding: RecordWatermark | null
  readonly model: RecordWatermark | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    bridgeCheckpoint: BridgeCheckpointState
  }
}

export interface NativePending {
  agent: Agent
  controller: AbortController
  task: Promise<NativeEntry>
}

export interface NativeEntry {
  agent: Agent
  binding: KernelBinding
  session: NativeSession
  controller: AbortController
}

export interface ModelBody extends NativeTurnOptions {
  sessionId: string
}

export interface CreateBody {
  backend: 'codex' | 'claude'
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}
