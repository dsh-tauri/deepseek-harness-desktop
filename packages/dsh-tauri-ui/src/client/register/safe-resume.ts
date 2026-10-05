import type { ClientContext } from 'dsh-tauri/client'
import type { ComposerSessionBinding, ComposerSessionsRuntime } from './composer-resume.types'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { SAFE_RESUME_DOCK_ID, SAFE_RESUME_DOCK_ORDER, SAFE_RESUME_INPUT_DOCK_SLOT } from '../constants'
import { forkRefusedSession } from '../service/safe-resume'
import { store } from '../store'
import { SafeResumeBar } from '../ui/safe-resume-bar'
import { safeResumeBoundary } from './composer-resume.utils'

/**
 * client/register/safe-resume.ts — 内容审核拒绝的安全恢复入口（issue #928）。
 *
 * 事件订阅方在 composer-resume 里已把「已知拒绝」写进 store，这里只负责渲染与恢复动作：
 * 从最后一个正常结束的回合边界分叉出子会话，再打开它。原会话一个事件都不动。
 */
export const safeResumeFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  if (typeof document === 'undefined')
    return

  const sessions = adapter.sessions as ComposerSessionsRuntime
  const sessionsBinding = sessions.binding
  if (typeof sessionsBinding !== 'function')
    return

  let pending = false

  function fail(sessionId: string, reason: string): void {
    console.warn(`[${PLUGIN_ID}] 安全恢复失败: ${reason}`)
    store.safeResume.failRecovery(sessionId)
  }

  async function recover(sessionId: string): Promise<void> {
    if (pending || sessionsBinding === undefined)
      return
    const binding = sessionsBinding(sessionId) as ComposerSessionBinding | undefined
    const atSeq = safeResumeBoundary(binding?.eventSource?.getSnapshot?.().entries)
    if (atSeq === undefined) {
      console.warn(`[${PLUGIN_ID}] 无法定位安全恢复边界，已保持原会话不变`)
      store.safeResume.markUnavailable(sessionId)
      return
    }
    pending = true
    try {
      store.safeResume.beginRecovery(sessionId)
      const outcome = await forkRefusedSession({ sessions, sessionId, atSeq })
      if (!outcome.ok) {
        fail(sessionId, outcome.error)
        return
      }
      store.safeResume.clear(sessionId)
      sessions.open?.(outcome.childId)
    }
    catch (error) {
      fail(sessionId, error instanceof Error ? error.message : String(error))
    }
    finally {
      pending = false
    }
  }

  controller.add(ctx.slots.inject(
    SAFE_RESUME_INPUT_DOCK_SLOT as never,
    () =>
      ctx.slots.register(
        {
          name: SAFE_RESUME_INPUT_DOCK_SLOT,
          id: SAFE_RESUME_DOCK_ID,
          order: SAFE_RESUME_DOCK_ORDER,
          registrant: PLUGIN_ID,
          inject: (sessionId?: string) => ({ sessionId, recover }),
        } as never,
        SafeResumeBar as never,
      ),
  ))
})
