/**
 * register/navigation.ts — 宿主「文件」菜单的两条命令（宿主 → iframe）：
 *
 * - `dsh://session:new`（新聊天）：官方「新建会话」同款入口；
 * - `dsh://workspace:add`（打开文件夹）：官方「添加工作区」流程
 *   （选目录 → 建工作区 → 在新工作区开会话）。
 *
 * 两条命令都只**调用**官方能力，不复制官方 UI：跨核心版本的服务形态漂移全部收在
 * 适配层（`register/index.adapter.ts`），能力缺席时由适配层退级到点官方按钮，
 * 两边都不可用才告警 —— 绝不静默半工作。协议字面量与 `src/layout/components/webview.tsx`
 * 逐字一致（只有本文件消费，按常量归属规则留在消费方）。
 */
import type { ClientContext, ParentMessage } from '../types'
import { invokeParent } from '../service/invoke-parent'
import { listenParent } from '../service/listen-parent'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'

/** 宿主 → iframe：新建会话命令。 */
const CMD_NEW_SESSION = 'dsh://session:new'

/** 宿主 → iframe：打开文件夹命令。 */
const CMD_ADD_WORKSPACE = 'dsh://workspace:add'

export const navigationFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  let openingSession: string | undefined
  let openedSession: string | undefined
  controller.add(listenParent<ParentMessage>((data) => {
    if (data.type === 'dsh://session:open' && typeof data.sessionId === 'string') {
      const sessionId = data.sessionId
      if (openedSession === sessionId) {
        invokeParent({ type: 'dsh://session:opened', sessionId })
        return
      }
      const list = adapter.sessionList()
      if (openingSession === sessionId || !list?.ids.includes(sessionId) || !adapter.has('navigation.openSession'))
        return
      openingSession = sessionId
      void (async () => {
        try {
          const outcome = adapter.openSession(sessionId)
          if (outcome.status !== 'opened')
            throw new Error(outcome.reason)
          await outcome.value
          openingSession = undefined
          openedSession = sessionId
          invokeParent({ type: 'dsh://session:opened', sessionId })
        }
        catch (error) {
          openingSession = undefined
          invokeParent({ type: 'dsh://session:opened', sessionId, error: String(error) })
        }
      })()
      return
    }
    if (data.type === CMD_NEW_SESSION) {
      // 目录选择器不可用 / 建工作区被拒等失败上报宿主插件面板，不影响后续命令。
      void adapter.startSession().catch((error: unknown) => reportPluginError(error))
      return
    }
    if (data.type === CMD_ADD_WORKSPACE)
      void adapter.addWorkspace({ openSession: true }).catch((error: unknown) => reportPluginError(error))
  }, [CMD_NEW_SESSION, CMD_ADD_WORKSPACE, 'dsh://session:open']))
})
