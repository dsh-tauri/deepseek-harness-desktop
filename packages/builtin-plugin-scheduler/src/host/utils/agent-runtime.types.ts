import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export interface PlatformModuleLoader {
  import: (name: string) => Promise<unknown>
  unwrapExports: (exports: unknown) => unknown
}

export interface SchedulerRuntimeModules {
  installModelSelection: (agentCtx: unknown, selection: {
    current: ModelSelection | undefined
    assembled: ModelSelection | undefined
  }) => () => void
  createUserMessage: (value: {
    content: readonly { type: 'text', text: string }[]
    source: unknown
  }) => UserMessage
  setApprovalPolicy: (session: unknown, policy: 'ask' | 'never') => void
}

export interface SetupAgentLike {
  readonly session: unknown
}
