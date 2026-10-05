import type { ComposerRefusal } from '../../register/composer-resume.types'

export type SafeResumePhase = 'idle' | 'running' | 'failing'

/** 一个会话已确认的内容审核拒绝：provider 原文 + 恢复动作阶段。 */
export interface SafeResumeRefusalState extends ComposerRefusal {
  phase: SafeResumePhase
}

export interface SafeResumeUiState {
  refusals: Record<string, SafeResumeRefusalState | undefined>
}
