import type { PendingInteractionFace, PendingQuestionFace, QuestionAnswerFace } from '../types'
import { pendingIdentity } from './approval'

/**
 * 多问题批次的「一题一轮」作答进度。
 *
 * 系统通知只有一个文本框，而宿主的校验是「每道题各一条答案，缺一条就 BAD_ANSWER」
 * （见 `dsh-user-questions` 的 `answer()`）：所以通知里没法一题一题地提交，只能先攒着，
 * 攒齐整批再一次性提交——这正是官方向导的做法（它把进度存在本地，最后提交完整批次）。
 */
interface WizardProgress {
  /** 进度归属的待处理交互身份：身份一变就作废（答完了 / 界面接手了 / 换了新提问）。 */
  readonly identity: string
  /** 当前该问第几题（0 起）。 */
  index: number
  /** 题目 id → 用户输入的自由文本（官方的 `custom` 答案）。 */
  readonly drafts: Map<string, string>
}

/** 通知里当前该问的一题。 */
export interface QuestionWizardStep {
  /** 待处理交互身份，随通知一起记下，作答时用它挡掉过期点击。 */
  readonly identity: string
  /** 0 起的题号与总题数，正文用它写「提问 2/3」。 */
  readonly index: number
  readonly total: number
  readonly id: string
  readonly question: PendingQuestionFace
}

/** 每个会话一份进度：宿主的待处理交互是会话级的，同一会话同时只有一个。 */
const progressBySession = new Map<string, WizardProgress>()

/** 官方作答按 id 回传，id 缺失的题通知里答不了。 */
function usableId(question: PendingQuestionFace | undefined): string | undefined {
  const id = question?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function progressFor(sessionId: string, identity: string): WizardProgress {
  const existing = progressBySession.get(sessionId)
  if (existing && existing.identity === identity)
    return existing
  const fresh: WizardProgress = { identity, index: 0, drafts: new Map() }
  progressBySession.set(sessionId, fresh)
  return fresh
}

/**
 * 这个待处理提问能不能在通知里驱动：**每道题都得有可用 id**。
 *
 * 只要有一题缺 id，整批就永远攒不齐（提交会被宿主判 BAD_ANSWER），此时不如不给回复按钮，
 * 让用户点通知回会话界面用官方向导作答。
 */
export function canDriveQuestions(pending: PendingInteractionFace): boolean {
  const questions = pending.questions ?? []
  return questions.length > 0 && questions.every(question => usableId(question) !== undefined)
}

/** 当前该问的一题；驱动不了（没题 / 缺 id）时为 `undefined`。 */
export function questionWizardStep(sessionId: string, pending: PendingInteractionFace): QuestionWizardStep | undefined {
  if (!canDriveQuestions(pending))
    return undefined
  const questions = pending.questions ?? []
  const progress = progressFor(sessionId, pendingIdentity(pending))
  // 题目变少（换了一批题）时把题号收回来，避免指向不存在的题。
  if (progress.index >= questions.length)
    progress.index = 0
  const index = progress.index
  const question = questions[index]
  const id = usableId(question)
  if (question === undefined || id === undefined)
    return undefined
  return { identity: progress.identity, index, total: questions.length, id, question }
}

/**
 * 记下这一轮输入的自由文本，并推进到下一题。
 *
 * @returns 整批已答完时给出符合官方契约的完整答案批次（交给调用方提交）；还有下一题时返回
 *   `undefined`（调用方据此再弹一条通知）。
 */
export function advanceQuestionWizard(sessionId: string, pending: PendingInteractionFace, text: string): QuestionAnswerFace[] | undefined {
  const step = questionWizardStep(sessionId, pending)
  const custom = text.trim()
  if (!step || !custom)
    return undefined
  const progress = progressFor(sessionId, step.identity)
  progress.drafts.set(step.id, custom)
  if (step.index < step.total - 1) {
    progress.index = step.index + 1
    return undefined
  }
  const answers: QuestionAnswerFace[] = []
  for (const question of pending.questions ?? []) {
    const id = usableId(question)
    const draft = id === undefined ? undefined : progress.drafts.get(id)
    // 有题没答到就不提交：攒不齐的批次宿主不收，交回会话界面作答。
    if (id === undefined || draft === undefined || draft === '')
      return undefined
    answers.push({ id, selected: [], custom: draft })
  }
  progressBySession.delete(sessionId)
  return answers
}

/**
 * 对齐观察到的待处理交互：身份一变就丢掉进度。
 *
 * 身份变了意味着这条批次的去向已经不由我们决定（在会话界面答完了、被新提问顶掉了），
 * 留着旧进度只会让下一轮指向错误的题号。
 */
export function syncQuestionWizard(sessionId: string, identity: string | undefined): void {
  const existing = progressBySession.get(sessionId)
  if (existing && existing.identity !== identity)
    progressBySession.delete(sessionId)
}
