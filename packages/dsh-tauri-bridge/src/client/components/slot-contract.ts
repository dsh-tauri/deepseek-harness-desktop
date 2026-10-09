import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SlotDecorationOriginalProps } from 'dsh-tauri-ui/client'
import type { AdapterSessionCreateOptions } from 'dsh-tauri/client'
import type { BackendId } from '../../shared/types'
import type { HERO_AGENT_PRESET_SLOT, MODEL_KERNEL_SLOT, SIDEBAR_KERNEL_HOVER_SLOT, SIDEBAR_KERNEL_SLOT } from '../constants'
import type { NativeModelActions } from '../types/kernel-model'

export interface KernelActions {
  canCreate: () => boolean
  createSession: (backend: BackendId, options: AdapterSessionCreateOptions, agentPreset?: string) => Promise<void>
  refreshBackends: () => Promise<void>
  ensureProjection: (sessionId: string) => Promise<void>
}

export type HeroKernelProps = PropsRuntime<typeof HERO_AGENT_PRESET_SLOT> & KernelActions
export type ModelKernelProps = PropsRuntime<typeof MODEL_KERNEL_SLOT> & Pick<KernelActions, 'ensureProjection'> & NativeModelActions & SlotDecorationOriginalProps
export type SessionKernelProps = PropsRuntime<typeof SIDEBAR_KERNEL_SLOT> & Pick<KernelActions, 'ensureProjection'>
export type SessionKernelHoverProps = PropsRuntime<typeof SIDEBAR_KERNEL_HOVER_SLOT> & Pick<KernelActions, 'ensureProjection'>
