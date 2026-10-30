import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { startUngroupedSession } from '../service/ungrouped-session'
import { newSessionButtonFrom, ungroupedCreateButtonFrom } from './new-session.utils'

function newSessionFeature(matcher: (target: unknown) => Element | null, warnText: string) {
  return defineRegister<ClientContext>((controller, ctx, adapter) => {
    if (typeof document === 'undefined')
      return

    let warned = false
    controller.listen('click', (event) => {
      if (matcher(event.target) === null)
        return
      if (!adapter.has('composer.workspace-less')) {
        if (!warned) {
          warned = true
          console.warn(warnText)
        }
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      startUngroupedSession(ctx, adapter)
    }, { capture: true })
  })
}

export const sidebarNewSessionFeature = newSessionFeature(
  newSessionButtonFrom,
  `[${PLUGIN_ID}] 「未分组」新建会话不可用：缺少桌面壳 composer 补丁（composer.workspace-less），沿用官方工作区选择。`,
)

export const ungroupedNewSessionFeature = newSessionFeature(
  ungroupedCreateButtonFrom,
  `[${PLUGIN_ID}] 「未分组」分组行新建会话不可用：缺少桌面壳 composer 补丁（composer.workspace-less），沿用官方行为。`,
)
