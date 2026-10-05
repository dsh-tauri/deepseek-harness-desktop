import type { ComposerRefusal } from '../../register/composer-resume.types'
import type { SafeResumeRefusalState, SafeResumeUiState } from './safe-resume.types'
import { defineStore } from 'dsh-tauri/client'

/**
 * 内容审核拒绝的会话级投影：事件订阅方（composer-resume）写入，dock 提示条读取，
 * 恢复动作在两者之间传递阶段。整表替换而非就地改键，保证任何读取方都能看到新快照。
 */
export const safeResume = defineStore({
  state: (): SafeResumeUiState => ({ refusals: {} }),
  actions: {
    capture(sessionId: string, refusal: ComposerRefusal) {
      const current = this.refusals[sessionId]
      // 幂等：写入会触发订阅方重扫，重复写入将自激成环。
      if (current !== undefined && current.message === refusal.message && current.code === refusal.code && current.status === refusal.status)
        return
      this.refusals = {
        ...this.refusals,
        [sessionId]: { ...refusal, phase: current?.phase === 'running' ? 'running' : 'idle' },
      }
    },
    clear(sessionId: string) {
      if (this.refusals[sessionId] === undefined)
        return
      const next = { ...this.refusals }
      delete next[sessionId]
      this.refusals = next
    },
    beginRecovery(sessionId: string) {
      const current = this.refusals[sessionId]
      if (current === undefined)
        return
      this.refusals = { ...this.refusals, [sessionId]: { ...current, phase: 'running' } }
    },
    failRecovery(sessionId: string) {
      const current: SafeResumeRefusalState | undefined = this.refusals[sessionId]
      if (current === undefined)
        return
      this.refusals = { ...this.refusals, [sessionId]: { ...current, phase: 'failing' } }
    },
  },
})
