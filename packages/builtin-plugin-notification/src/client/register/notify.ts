import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AdapterListProjection, ClientContext } from 'dsh-tauri/client'
import type { FocusGateInput } from '../service/decision'
import type { NativeNotificationAction, NotificationKind, PendingInteractionFace, SessionsFace, UiSessionFace } from '../types'
import { defineRegister, emit, listen } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, REPLY_ACTION_ID } from '../constants'
import { locale } from '../locales'
import { answerQuestionBatch, approveInteraction, pendingDetail, pendingIdentity, pendingNotificationKind, readPendingInteraction, rejectInteraction } from '../service/approval'
import { allowPendingNotification, allowTurnNotification, boundText, notificationTag } from '../service/decision'
import { closeNativeNotifications, showNativeNotification } from '../service/native'
import { advanceQuestionWizard, canDriveQuestions, questionWizardStep, syncQuestionWizard } from '../service/question-wizard'
import { createSoundPlayer } from '../service/sound'
import { readTurnEnd } from '../service/turn-end'
import { notificationSettings } from '../store'

/** 状态抖动合并窗口：running 可能连续翻转几次，等它稳定后再判断是否提醒。 */
const SETTLE_MS = 250
/** 通知正文上限。 */
const MAX_BODY_CHARS = 400
/** 会话尚未出现在列表里时，聚焦重试次数与间隔。 */
const FOCUS_RETRY_LIMIT = 6
const FOCUS_RETRY_MS = 200
/** 等待 `uiSession` 服务注册的上限（20 × 250ms = 5s）。 */
const UI_SESSION_WAIT_LIMIT = 20
const UI_SESSION_WAIT_MS = 250

/** 单次观察到的会话状态（`uiSession` 缺席时退化为列表里的 running）。 */
interface SessionObservation {
  readonly running: boolean | undefined
  readonly pending: PendingInteractionFace | undefined
}

/**
 * 通知运行时：把客户端状态变化翻译成原生通知。
 *
 * 数据全部来自客户端服务——`sessions.list`（会话标题、当前会话、running 兜底）与
 * `uiSession.sessionStatus`（运行态与待处理交互）。两者都用最小结构面读取，
 * 服务缺席时降级而不是报错。
 */
export const notifyFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  // 归档集合缺席时只丢掉「归档抑制」，通知照常发：新版宿主才有这份快照。
  const workspaceSource = adapter.has('workspaces.list') ? adapter.workspaces.list as AdapterListProjection<WorkspaceSnapshot> : undefined
  const isArchived = (sessionId: string): boolean => {
    const archivedSessionIds: readonly string[] = workspaceSource?.getSnapshot().archivedSessionIds ?? []
    return archivedSessionIds.includes(sessionId)
  }
  const sound = createSoundPlayer()
  controller.add(sound.dispose)

  const observationTokens = new Map<string, object>()
  const seenRunning = new Map<string, boolean | undefined>()
  const seenPending = new Map<string, string | undefined>()
  const timers = new Map<string, () => void>()
  // 已投递到系统通知中心的通知：tag → 发起它的会话。用户回到该会话时按这张表关掉。
  const delivered = new Map<string, string>()
  // 正在关闭的 tag：同一批通知不并发重复提交。
  const closing = new Set<string>()
  let sequence = 0

  const readSessions = (): SessionsFace | undefined => ctx.get('sessions') as SessionsFace | undefined
  const readUiSession = (): UiSessionFace | undefined => ctx.get('uiSession') as UiSessionFace | undefined

  const sessionTitle = (sessionId: string): string => {
    const summary = readSessions()?.list.getSnapshot().byId[sessionId]
    return summary?.displayTitle?.trim() || summary?.title?.trim() || locale.text('sessionFallback')
  }

  /** 通知门控看的位置：当前会话取会话列表投影，读不到就当「不知道用户在看哪」。 */
  function focusGate(sessionId: string): FocusGateInput {
    return {
      hostHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      sessionId,
      currentSessionId: adapter.sessionList()?.current,
    }
  }

  const focusSession = (sessionId: string, attempt = 0): void => {
    const outcome = adapter.openSession(sessionId)
    if (outcome.status === 'opened')
      return
    if (attempt >= FOCUS_RETRY_LIMIT) {
      console.warn(`[${PLUGIN_ID}] cannot focus session ${sessionId}: ${outcome.reason}`)
      return
    }
    controller.timeout(() => {
      focusSession(sessionId, attempt + 1)
    }, FOCUS_RETRY_MS)
  }

  void (async () => {
    const clicked = await listen<{ sessionId?: string, action?: string, sourceOrigin?: string }>('dsh://notification-clicked', ({ payload }) => {
      if (!controller.isDisposed() && payload.sourceOrigin === location.origin && !payload.action && typeof payload.sessionId === 'string' && payload.sessionId !== '')
        focusSession(payload.sessionId)
    })
    if (controller.isDisposed()) {
      clicked()
      return
    }
    controller.add(clicked)
    const ready = await listen('dsh://notification-ready-request', () => {
      if (!controller.isDisposed())
        void emit('dsh://notification-ready', { sourceOrigin: location.origin })
    })
    if (controller.isDisposed()) {
      ready()
      return
    }
    controller.add(ready)
    await emit('dsh://notification-ready', { sourceOrigin: location.origin })
  })().catch(error => console.error(`[${PLUGIN_ID}] notification listener failed`, error))

  /** 用户回到某个会话即视为已读：把这个会话还挂在系统通知中心里的通知关掉。 */
  const dismissSession = (sessionId: string): void => {
    if (delivered.size === 0)
      return
    const tags = [...delivered].filter(([tag, owner]) => owner === sessionId && !closing.has(tag)).map(([tag]) => tag)
    if (tags.length === 0)
      return
    for (const tag of tags)
      closing.add(tag)
    void closeNativeNotifications(tags).then((closed) => {
      for (const tag of tags)
        closing.delete(tag)
      // 桥拒绝了就留着记录，用户下次回到这个会话时再试。
      if (!closed)
        return
      for (const tag of tags)
        delivered.delete(tag)
    })
  }

  /** 窗口回到前台时，用户正停在的那个会话的通知就算已读。 */
  const dismissViewed = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      return
    const current = adapter.sessionList()?.current
    if (!current)
      return
    dismissSession(current)
  }

  // 窗口回到前台就按「用户此刻在看哪个会话」清掉那个会话的通知（issue #1587）。
  if (typeof document !== 'undefined')
    controller.listen('visibilitychange', dismissViewed)

  const notify = (sessionId: string, kind: NotificationKind, title: string, body: string, requireInteraction: boolean, actions?: NativeNotificationAction[], onAction?: (action: string, inputValue: string | null) => void, deliveryKey?: string): void => {
    if (controller.isDisposed() || isArchived(sessionId))
      return
    const settings = notificationSettings.$state
    sequence += 1
    const tag = notificationTag(sessionId, kind, sequence)
    void showNativeNotification({
      title,
      body: boundText(body, MAX_BODY_CHARS),
      tag,
      sessionId,
      deliveryKey,
      requireInteraction,
      silent: true,
      actions,
      onAction,
    }).then((accepted) => {
      if (!accepted || controller.isDisposed())
        return
      delivered.set(tag, sessionId)
      sound.play(settings.sound, settings.customSound)
      // 等待投递期间用户可能已经回到这个会话：补一次已读检查。
      dismissViewed()
    })
  }

  const approveFromNotification = async (sessionId: string, identity: string): Promise<void> => {
    const result = await approveInteraction(readUiSession(), sessionId, identity)
    if (!result.ok)
      console.warn(`[${PLUGIN_ID}] approve from notification failed: ${result.error ?? 'unknown'}`)
  }

  const rejectFromNotification = async (sessionId: string, identity: string): Promise<void> => {
    const result = await rejectInteraction(readUiSession(), sessionId, identity)
    if (!result.ok)
      console.warn(`[${PLUGIN_ID}] reject from notification failed: ${result.error ?? 'unknown'}`)
  }

  /**
   * 提问的「回复」按钮。系统通知渲染不了选项列表，只能收自由文本，所以按钮带一个输入框；
   * 每个按钮都带上这条通知当初展示的那次挂起（`identity`），作答时用它挡掉过期点击。
   */
  const questionActions = (): NativeNotificationAction[] => [{
    id: REPLY_ACTION_ID,
    title: locale.text('reply'),
    input: true,
    inputPlaceholder: locale.text('replyPlaceholder'),
    inputButtonTitle: locale.text('reply'),
  }]

  const questionOnAction = (sessionId: string, identity: string) => (action: string, inputValue: string | null): void => {
    if (action !== REPLY_ACTION_ID)
      return
    // 非 Windows 平台插件没有文本框，带 `input` 的按钮会退化成普通按钮：这时点击拿不到文本，
    // 静默丢弃会让用户以为通知坏了，改为把会话拉到前台去回答。
    if (inputValue)
      void replyFromNotification(sessionId, inputValue, identity)
    else
      focusSession(sessionId)
  }

  /**
   * 弹一条提问通知：多问题批次一题一条，正文写「提问 2/3 · 题目」，用户一眼看到还有几轮要决策。
   *
   * @returns 是否真的弹了（驱动不了这一批提问时为 `false`，调用方改为只提醒）。
   */
  const notifyQuestionRound = (sessionId: string, pending: PendingInteractionFace): boolean => {
    const step = questionWizardStep(sessionId, pending)
    if (!step)
      return false
    const label = locale.text('labelQuestion')
    const detail = step.question.question?.trim() || step.question.header?.trim() || locale.text('bodyQuestion')
    const body = step.total > 1 ? `${label} ${step.index + 1}/${step.total} · ${detail}` : `${label} · ${detail}`
    notify(sessionId, 'question', sessionTitle(sessionId), body, true, questionActions(), questionOnAction(sessionId, step.identity), JSON.stringify([sessionId, 'question', step.identity, step.index]))
    return true
  }

  /**
   * 通知里的回复。多问题批次按官方向导的做法一题一轮：先在本地攒着，攒齐整批再一次性提交。
   *
   * 宿主的校验要求每条答案对准一道题、缺一条就 BAD_ANSWER，所以中间几轮只是把下一题弹出来，
   * 最后一轮才真正提交；整批提交前后都用身份挡掉过期点击。
   */
  async function replyFromNotification(sessionId: string, text: string, identity: string): Promise<void> {
    const uiSession = readUiSession()
    const pending = readPendingInteraction(uiSession, sessionId)
    if (!pending || (pending.kind !== 'question' && pending.kind !== 'plan-review')) {
      console.warn(`[${PLUGIN_ID}] reply from notification failed: QUESTION_UNAVAILABLE`)
      return
    }
    if (pendingIdentity(pending) !== identity) {
      console.warn(`[${PLUGIN_ID}] reply from notification failed: QUESTION_STALE`)
      return
    }
    const answers = advanceQuestionWizard(sessionId, pending, text)
    if (!answers) {
      // 还有下一题：接着弹一条，用户顺着通知就把整批答完了。
      if (notifyQuestionRound(sessionId, pending))
        return
      console.warn(`[${PLUGIN_ID}] question batch ${identity} cannot be completed from notifications, answer it in the session view`)
      return
    }
    const result = await answerQuestionBatch(uiSession, sessionId, answers, identity)
    if (!result.ok)
      console.warn(`[${PLUGIN_ID}] reply from notification failed: ${result.error ?? 'unknown'}`)
  }

  /** 合并窗口结束后再确认状态仍然成立，避免「刚弹通知就被新状态推翻」。 */
  const settle = (key: string, run: () => void): void => {
    timers.get(key)?.()
    const cancel = controller.timeout(() => {
      timers.delete(key)
      run()
    }, SETTLE_MS)
    timers.set(key, cancel)
  }

  const reconcilePending = (sessionId: string, pending: PendingInteractionFace, changed: boolean): void => {
    if (!changed)
      return
    settle(`${sessionId}:pending`, () => {
      const current = readUiSession()?.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction
      if (!current || pendingIdentity(current) !== pendingIdentity(pending))
        return
      const kind = pendingNotificationKind(current)
      if (!kind)
        return
      if (!allowPendingNotification(notificationSettings.$state, kind, focusGate(sessionId)))
        return
      const detail = pendingDetail(current)
      const fallback = kind === 'approval' ? locale.text('bodyApproval') : locale.text('bodyQuestion')
      const label = kind === 'approval' ? locale.text('labelApproval') : locale.text('labelQuestion')
      // 通知按钮一律要求交互仍可回答：答应不了的时候给按钮只会让用户白点。
      const answerable = current.answerable !== false && typeof current.answer === 'function'
      const identity = pendingIdentity(current)
      // 提问：能驱动就一题一条通知（多问题批次由 question-wizard 在本地攒齐整批再提交），
      // 驱动不了（有题目缺 id，整批永远攒不齐）就只提醒，点通知本体回会话界面用官方向导作答。
      if (kind === 'question' && answerable && canDriveQuestions(current)) {
        notifyQuestionRound(sessionId, current)
        return
      }
      // 授权给「批准 / 拒绝」。每个按钮都带上这条通知当初展示的那次挂起（`identity`）：系统
      // 通知会一直挂到用户处理它为止，期间会话可能已经有**新的**待处理交互，身份对不上就不
      // 回答（见 approval.ts 的 APPROVAL_STALE / QUESTION_STALE）。
      const actions: NativeNotificationAction[] | undefined = kind === 'approval' && answerable
        ? [
            { id: APPROVE_ACTION_ID, title: locale.text('approve') },
            { id: REJECT_ACTION_ID, title: locale.text('reject') },
          ]
        : undefined
      const onAction = actions
        ? (action: string): void => {
            if (action === APPROVE_ACTION_ID)
              void approveFromNotification(sessionId, identity)
            else if (action === REJECT_ACTION_ID)
              void rejectFromNotification(sessionId, identity)
          }
        : undefined
      notify(
        sessionId,
        kind,
        // 标题放会话 title、正文放「动作 · 摘要」：与会话列表、桌宠气泡一致，用户一眼能认出
        // 是哪个会话、要做什么（系统通知的宽度只够一行摘要）。
        sessionTitle(sessionId),
        `${label} · ${detail || fallback}`,
        true,
        actions,
        onAction,
        JSON.stringify([sessionId, kind, identity]),
      )
    })
  }

  const reconcileTurn = (sessionId: string, finished: boolean): void => {
    if (!finished)
      return
    const token = observationTokens.get(sessionId)
    settle(`${sessionId}:turn`, () => {
      if (controller.isDisposed() || isArchived(sessionId) || observationTokens.get(sessionId) !== token)
        return
      const status = readUiSession()?.sessionStatus.getSnapshot().get(sessionId)
      const summary = readSessions()?.list.getSnapshot().byId[sessionId]
      if (status ? status.running === true : summary?.running === true)
        return
      const mode = notificationSettings.$state.turnComplete
      if (!allowTurnNotification({ ...focusGate(sessionId), mode }))
        return
      // 「用户手动中断」和「跑完了」在客户端看到的是同一个 `running: false`：结束原因只在宿主
      // 的 `turn/end` 里，所以弹之前问一次宿主；是中断就什么都不做（用户自己掐断的，不需要提醒）。
      void (async () => {
        const fact = await readTurnEnd(sessionId)
        if (fact.interrupted)
          return
        if (controller.isDisposed() || isArchived(sessionId) || observationTokens.get(sessionId) !== token)
          return
        // 问宿主是异步的，等待期间会话可能又跑起来了：再确认一次，别给正在干活的会话弹「已完成」。
        const currentStatus = readUiSession()?.sessionStatus.getSnapshot().get(sessionId)
        const currentSummary = readSessions()?.list.getSnapshot().byId[sessionId]
        if (currentStatus ? currentStatus.running === true : currentSummary?.running === true)
          return
        // ponytail: hosts without a turn identity use updatedAt; upgrade the host for exact turn deduplication.
        const identity = fact.turn ?? currentSummary?.updatedAt
        notify(
          sessionId,
          'turn',
          sessionTitle(sessionId),
          locale.text('labelTurn'),
          false,
          undefined,
          undefined,
          identity === undefined ? undefined : JSON.stringify([sessionId, 'turn', identity]),
        )
      })()
    })
  }

  const reconcile = (entries: ReadonlyMap<string, SessionObservation>): void => {
    for (const [sessionId, observed] of entries) {
      const pendingKey = observed.pending ? pendingIdentity(observed.pending) : undefined
      // 待处理交互换了（答完了 / 被新提问顶掉了）就丢掉攒了一半的作答进度，避免题号错位。
      syncQuestionWizard(sessionId, pendingKey)
      const known = seenRunning.has(sessionId) || seenPending.has(sessionId)
      const previousRunning = seenRunning.get(sessionId)
      const previousPending = seenPending.get(sessionId)
      seenRunning.set(sessionId, observed.running)
      seenPending.set(sessionId, pendingKey)
      // 首次观察只建立基线：插件加载前就存在的完成态与待处理交互不该补弹通知。
      if (!known) {
        observationTokens.set(sessionId, {})
        continue
      }
      if (observed.pending && pendingKey !== previousPending)
        reconcilePending(sessionId, observed.pending, true)
      reconcileTurn(sessionId, previousRunning === true && observed.running !== true)
    }
    for (const sessionId of [...seenRunning.keys()]) {
      if (entries.has(sessionId))
        continue
      observationTokens.delete(sessionId)
      seenRunning.delete(sessionId)
      seenPending.delete(sessionId)
      syncQuestionWizard(sessionId, undefined)
      timers.get(`${sessionId}:pending`)?.()
      timers.get(`${sessionId}:turn`)?.()
      timers.delete(`${sessionId}:pending`)
      timers.delete(`${sessionId}:turn`)
    }
  }

  const observe = (): void => {
    // 切会话不会改变「窗口是否在前台」，所以这里单独再看一次已读。
    dismissViewed()
    const list = readSessions()?.list.getSnapshot()
    if (!list)
      return
    const statuses = readUiSession()?.sessionStatus.getSnapshot()
    const entries = new Map<string, SessionObservation>()
    for (const sessionId of list.ids) {
      const summary = list.byId[sessionId]
      // 子代理会话由父会话驱动，与桌宠（use-bubble-tracker）一致：不进观察集，也就不发通知。
      if (summary?.origin === 'subagent' || isArchived(sessionId))
        continue
      const status = statuses?.get(sessionId)
      entries.set(sessionId, {
        running: status ? status.running : summary?.running,
        pending: status?.pendingInteraction,
      })
    }
    reconcile(entries)
  }

  // 会话列表是常驻服务：用它驱动观察，顺带拿到标题与当前会话。
  if (workspaceSource)
    controller.add(workspaceSource.subscribe(observe))
  const listSource = readSessions()?.list
  if (listSource) {
    controller.add(listSource.subscribe(observe))
    observe()
  }

  // `uiSession` 的注册时机不由本插件决定，最多等 5 秒；等到了就订阅，等不到则维持列表兜底。
  let statusAttempts = 0
  const attachStatus = (): void => {
    const source = readUiSession()?.sessionStatus
    if (!source) {
      if (statusAttempts < UI_SESSION_WAIT_LIMIT && !controller.isDisposed()) {
        statusAttempts += 1
        controller.timeout(attachStatus, UI_SESSION_WAIT_MS)
      }
      return
    }
    controller.add(source.subscribe(observe))
    observe()
  }
  attachStatus()
})
