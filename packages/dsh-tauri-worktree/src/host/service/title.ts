import type { HostContext } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { get, isString } from 'lodash-es'
import { pendingWorktreeTitles } from '../config/runtime'
import { server } from '../server'

/** 宿主实例在插件卸载后就取不到了（读取即抛错），补标题这种锦上添花的能力绝不因此冒泡。 */
function hostInstance(): any {
  try {
    return getServerContext<HostContext>(server)
  }
  catch {
    return undefined
  }
}

export const worktreeTitle = defineService({
  /**
   * 工作树会话的显式标题生成（首个请求头落盘时调用一次）。
   *
   * 内核只对「无父会话 + 第一条人类消息 + 尚无标题」的全新会话自动生成标题，工作树会话是 fork 子会话，
   * 永远拿不到自动标题；继承前缀里没有人类消息时（工作树模式发送首条消息），它只会剩首条消息的兜底标题。
   * `sessionTitle.refresh()` 是官方给「自动生成没跑」准备的显式入口，缺席或失败都不影响任务本身。
   */
  async refresh(session: unknown): Promise<void> {
    const sessionId = get(session, 'id')
    if (!isString(sessionId) || !pendingWorktreeTitles.delete(sessionId))
      return
    try {
      await hostInstance()?.get?.('sessionTitle')?.refresh?.(session)
    }
    catch (error) {
      hostInstance()?.logger?.warn?.(`dsh-tauri-worktree: worktree session title failed for ${sessionId}: ${get(error, 'message', String(error))}`)
    }
  },
})
