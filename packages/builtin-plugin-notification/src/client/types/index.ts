/**
 * 跨模块共享的类型。
 *
 * 这里只声明**结构类型**：`sessions` / `uiSession` 等服务由 dsh-client-ui 系列包提供，
 * 而它们不在本仓库的依赖内（只有宿主半边 @deepseek-ai 包可被本地解析），因此按
 * `source/dsh-notification` 的既有做法用最小结构面（structural face）读取，
 * 不 `import type` 那些缺席的包。
 */

/** `ObservableSnapshot<T>`：getSnapshot + subscribe 的最小面。 */
export interface ObservableSnapshotFace<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** 会话摘要（`SessionListState.byId` 的值）。 */
export interface SessionSummaryFace {
  readonly id: string
  readonly title?: string
  readonly displayTitle?: string
  /** 宿主标注的子代理会话；与桌宠一致，不参与通知。 */
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly updatedAt?: number
}

/** `SessionListState`：只取通知需要的字段。 */
export interface SessionListStateFace {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryFace>>
}

/** 客户端 `sessions` 服务的最小面。 */
export interface SessionsFace {
  readonly list: ObservableSnapshotFace<SessionListStateFace>
}

/** 提问的一个可选项（官方 `AskUserQuestionOption`）。 */
export interface PendingQuestionOptionFace {
  /** 作答时回传的就是 `label` 字面值（官方 `selected` 收的是 label，不是 id）。 */
  readonly label?: string
  readonly description?: string
}

/** 待处理交互的选项（`PendingQuestion` 的 questions 项）。 */
export interface PendingQuestionFace {
  /** 官方 `AskUserQuestionItem.id`：作答时必须原样回传。 */
  readonly id?: string
  readonly question?: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly PendingQuestionOptionFace[]
  readonly multiSelect?: boolean
}

/** 授权结果：与官方 `ApprovalDecision` 对齐，通知上的「批准 / 拒绝」分别对应两个取值。 */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/** 一条提问回答：与官方 `AskUserQuestionAnswerItem` 对齐（`selected` 收的是选项 label）。 */
export interface QuestionAnswerFace {
  readonly id: string
  readonly selected: readonly string[]
  /** 自由输入的「其他」答案；系统通知的输入框走这里。 */
  readonly custom?: string
}

/** 提问回答批次：与官方 `AskUserQuestionAnswer` 对齐。 */
export interface QuestionOutcomeFace {
  readonly answers: readonly QuestionAnswerFace[]
}

/** 待处理交互能接受的作答：授权决定，或提问回答批次。 */
export type PendingOutcome = ApprovalDecision | QuestionOutcomeFace

/**
 * 待处理交互（`PendingApproval` / `PendingQuestion`）。
 *
 * `kind` 取 `'approval' | 'question' | 'plan-review'`；`answerable` 与 `answer`
 * 只有已注册的交互才存在，因此都声明为可选。
 */
export interface PendingInteractionFace {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: unknown
  readonly answerable?: boolean
  readonly questions?: readonly PendingQuestionFace[]
  answer?: (outcome: PendingOutcome) => Promise<void>
}

/** 单个会话的状态（`SessionStatus`）。 */
export interface SessionStatusFace {
  readonly running: boolean | undefined
  readonly pendingInteraction: PendingInteractionFace | undefined
  readonly completionUnread: boolean
}

/** 客户端 `uiSession` 服务的最小面。 */
export interface UiSessionFace {
  readonly sessionStatus: ObservableSnapshotFace<ReadonlyMap<string, SessionStatusFace>>
}

/** 原生通知按钮。 */
export interface NativeNotificationAction {
  readonly id: string
  readonly title: string
  /**
   * Windows：把按钮渲染成「输入框 + 提交按钮」，用户输入的文本随动作一起回传。
   * 其他平台忽略该字段，退化成普通按钮。
   */
  readonly input?: boolean
  /** Windows：输入框占位文案（`<input placeHolderContent>`）。 */
  readonly inputPlaceholder?: string
  /** Windows：提交按钮文案；缺省时用 `title`。 */
  readonly inputButtonTitle?: string
}

/** 原生通知描述。 */
export interface NativeNotificationInput {
  readonly title: string
  readonly body: string
  readonly tag: string
  readonly sessionId: string
  readonly requireInteraction?: boolean
  /**
   * 让系统通知保持静音：提示音由插件自己播放，避免系统默认音再响一次（双声）。
   */
  readonly silent?: boolean
  readonly actions?: readonly NativeNotificationAction[]
  /** 用户点通知本体（非按钮）。 */
  readonly onClick?: () => void
  /** 用户点按钮：回传 action id 与该按钮输入框里的文本（无输入框或没填时为 `null`）。 */
  readonly onAction?: (action: string, inputValue: string | null) => void
}

/** 通知类别：决定文案与是否需要常驻。 */
export type NotificationKind = 'turn' | 'approval' | 'question'

/** 设置项：轮次完成通知时机。 */
export type TurnCompleteMode = 'never' | 'background' | 'always'

/** 设置项：通知提示音。 */
export type NotificationSound = 'default' | 'classic' | 'none' | 'custom'

/** 内置提示音（包内 `assets/*.wav`）。 */
export type BuiltinNotificationSound = 'default' | 'classic'

/** 持久化设置。 */
export interface NotificationSettings {
  turnComplete: TurnCompleteMode
  approval: boolean
  question: boolean
  sound: NotificationSound
  customSound: string | null
}
