import type { NotificationKind, NotificationSettings, TurnCompleteMode } from '../types'

/** 通知门控所处的位置：宿主窗口在不在后台，以及用户正在看哪个会话。 */
export interface FocusGateInput {
  /** 宿主窗口是否隐藏/最小化/失焦。 */
  readonly hostHidden: boolean
  /** 产生通知的会话。 */
  readonly sessionId: string
  /** 当前正在查看的会话。 */
  readonly currentSessionId: string | undefined
}

/** 轮次完成通知的触发条件。 */
export interface TurnGateInput extends FocusGateInput {
  /** 用户设置：从不 / 仅在未聚焦时 / 始终。 */
  readonly mode: TurnCompleteMode
}

/**
 * 用户是否正停在产生通知的那个会话上。
 *
 * 语义与 ChatGPT 面板一致：窗口不在前台，**或**用户已切到别的会话，都算「未聚焦」。
 *
 * 当前会话读不到时（会话投影缺席 / 还没打开任何会话）按「未聚焦」处理：参考实现
 * `source/dsh-notification/src/client/notifier.ts` 的 `shouldShow` 也只在能确定
 * 「用户就停在这个会话上」时才抑制，宁可多提醒一次也不能漏掉一次。
 */
function watchingSession(input: FocusGateInput): boolean {
  return !input.hostHidden && input.currentSessionId === input.sessionId
}

/** 轮次完成是否该提醒。`background` 只在用户没盯着这个会话时才提醒。 */
export function allowTurnNotification(input: TurnGateInput): boolean {
  if (input.mode === 'never')
    return false
  if (input.mode === 'always')
    return true
  return !watchingSession(input)
}

/**
 * 权限 / 提问是否该提醒。
 *
 * 挂起交互意味着 DSH 正卡在那里等用户：窗口在前台、且用户就停在这个会话上时，审批框或
 * 提问就在眼前，再弹一条系统通知纯属打扰（参考实现 `source/dsh-notification/src/client/index.ts`
 * 的 pending runner 调的就是同一个 `shouldShow`）。窗口在后台、或用户已经切到别的会话时照旧
 * 提醒；当前会话读不到时同样按「未聚焦」处理。
 *
 * 用户的「提醒时机」选到 `always` 时这层抑制整体让位：既然连「我正看着这个会话」都要提醒，
 * 挂起交互当然也照提醒（参考实现里完成通知与 pending runner 共用同一个 `backgroundOnly`
 * 开关，移植成三态后只有 `always` 明确表示「不必替我省略」）。`never` 只管轮次完成，
 * 挂起交互仍按「看着就不打扰」抑制——宁可少弹一条，也不要在用户明确要求安静时打扰他。
 */
export function allowPendingNotification(
  settings: NotificationSettings,
  kind: 'approval' | 'question',
  gate: FocusGateInput,
): boolean {
  if (kind === 'approval' ? !settings.approval : !settings.question)
    return false
  if (settings.turnComplete === 'always')
    return true
  return !watchingSession(gate)
}

/** 通知 tag：同时是点击/按钮回调的查找键，序号保证同会话多条互不覆盖。 */
export function notificationTag(sessionId: string, kind: NotificationKind, sequence: number): string {
  const prefix = kind === 'turn' ? 'dsh-notification' : 'dsh-notification-pending'
  return `${prefix}-${sessionId}-${sequence}`
}

/** 截断正文，避免超长标题/命令撑爆系统通知。 */
export function boundText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}
