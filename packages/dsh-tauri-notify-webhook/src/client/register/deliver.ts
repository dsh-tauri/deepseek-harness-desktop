import type { ClientContext } from 'dsh-tauri/client'
import type { NotifyTrigger, SessionsFace } from '../types/index'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { postDelivery } from '../apis/index'
import { resolveTrigger } from '../service/delivery'

/** running 可能连续翻转几次，等它稳定后再判定回合真的结束了。 */
const SETTLE_MS = 250

export const deliverFeature = defineRegister<ClientContext>((controller, ctx) => {
  const seenRunning = new Map<string, boolean | undefined>()
  const timers = new Map<string, () => void>()

  const readSessions = (): SessionsFace | undefined => ctx.get('sessions') as SessionsFace | undefined

  const isRunning = (sessionId: string): boolean => readSessions()?.list.getSnapshot().byId[sessionId]?.running === true

  function settle(sessionId: string, run: () => void): void {
    timers.get(sessionId)?.()
    timers.set(sessionId, controller.timeout(() => {
      timers.delete(sessionId)
      run()
    }, SETTLE_MS))
  }

  /** 宿主补丁把 `document.hidden` 映射成窗口状态：只有窗口没聚焦时才推送，不打扰正在看的人。 */
  function hiddenNow(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  async function dispatch(sessionId: string, trigger: NotifyTrigger): Promise<void> {
    if (!hiddenNow())
      return
    const summary = readSessions()?.list.getSnapshot().byId[sessionId]
    const title = summary?.displayTitle?.trim() || summary?.title?.trim() || ''
    try {
      const result = await postDelivery({ sessionId, title, trigger })
      if (result.ok !== true)
        console.warn(`[${PLUGIN_ID}] 推送失败：${result.error ?? ''}`)
    }
    catch (error) {
      console.warn(`[${PLUGIN_ID}] 推送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reconcile = (entries: ReadonlyMap<string, boolean | undefined>): void => {
    for (const [sessionId, running] of entries) {
      const known = seenRunning.has(sessionId)
      const previous = seenRunning.get(sessionId)
      seenRunning.set(sessionId, running)
      // 首次观察只建立基线：插件加载前就存在的完成态不该补推一条通知。
      if (!known || previous !== true || running === true)
        continue
      settle(sessionId, () => {
        // 窗口内可能又跑起来了：与通知插件一样，落定后再确认一次状态。
        if (isRunning(sessionId))
          return
        void resolveTrigger(sessionId).then((trigger) => {
          // 问原因这一趟往返里插件可能已被卸载、会话也可能又跑起来，投递前再确认一次。
          if (controller.isDisposed() || isRunning(sessionId))
            return
          void dispatch(sessionId, trigger)
        })
      })
    }
    for (const sessionId of [...seenRunning.keys()]) {
      if (entries.has(sessionId))
        continue
      seenRunning.delete(sessionId)
      timers.get(sessionId)?.()
      timers.delete(sessionId)
    }
  }

  const observe = (): void => {
    const list = readSessions()?.list.getSnapshot()
    if (!list)
      return
    const entries = new Map<string, boolean | undefined>()
    for (const sessionId of list.ids) {
      const summary = list.byId[sessionId]
      // 子代理会话由父会话驱动，与桌宠、原生通知一致：不进观察集，也就不推送。
      if (summary?.origin === 'subagent')
        continue
      entries.set(sessionId, summary?.running)
    }
    reconcile(entries)
  }

  const listSource = readSessions()?.list
  if (listSource) {
    controller.add(listSource.subscribe(observe))
    observe()
  }
})
