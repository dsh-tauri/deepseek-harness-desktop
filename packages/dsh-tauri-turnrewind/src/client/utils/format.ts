/**
 * client/utils/format.ts — 纯函数：计数文本、文件名、卡片状态判定、文件清单裁剪。
 *
 * 全部为纯函数，便于单测直接锁定（agents.plugins.md「优先测试纯函数」）。
 * 计数文本供 `ChangeCounts` 的 `title` 使用：视觉是分开着色的两个 span，
 * 但读屏/悬浮提示要拿到同一条「+N -M」文本。
 */

import type { LocaleKey, SessionSummary, TurnCardState, TurnFileChange, TurnSummary } from '../types'
import {
  TURNREWIND_REASON_EXPIRED,
  TURNREWIND_REASON_GIT_REQUIRED,
  TURNREWIND_REASON_GIT_UNAVAILABLE,
  TURNREWIND_REASON_SNAPSHOT_FAILED,
  TURNREWIND_REASON_TURN_ACTIVE,
  TURNREWIND_REASON_UNSAFE_PATH,
  TURNREWIND_REASON_WORKSPACE_BUSY,
} from '../../shared/constants'

/**
 * 线协议上的「不可用原因」码 → 文案键。
 *
 * 卡片必须给出人能读懂的原因，而不是把 `TURNREWIND_EXPIRED` 这样的码直接糊到界面上；
 * 但同时**不能丢掉未知码**（内核/宿主版本可能更新），未知码仍原样显示（见调用方）。
 */
const REASON_KEYS: Record<string, LocaleKey> = {
  // `GIT_REQUIRED` 刻意**没有**文案映射：非 Git 工作区整张卡片都不渲染（见 resolveCardState）。
  [TURNREWIND_REASON_GIT_UNAVAILABLE]: 'gitUnavailableReason',
  [TURNREWIND_REASON_EXPIRED]: 'expiredReason',
  [TURNREWIND_REASON_TURN_ACTIVE]: 'turnActiveReason',
  [TURNREWIND_REASON_SNAPSHOT_FAILED]: 'snapshotFailedReason',
  [TURNREWIND_REASON_UNSAFE_PATH]: 'unsafePathReason',
  // 工作区被另一个宿主进程占用：**可重试**，语义与上面几个终态原因不同（见字典文案）。
  [TURNREWIND_REASON_WORKSPACE_BUSY]: 'workspaceBusyReason',
}

/**
 * 原因码对应的文案键；未知码或空值返回 null（调用方决定如何降级展示）。
 * @param reason - 宿主回传的原因码。
 * @returns 文案键或 null。
 */
export function reasonKey(reason: string | null | undefined): LocaleKey | null {
  if (reason === null || reason === undefined || reason.length === 0)
    return null
  return REASON_KEYS[reason] ?? null
}

/** 单行 `+N -M` 文本；二进制显示 binaryLabel。 */
export function formatCounts(file: Pick<TurnFileChange, 'insertions' | 'deletions' | 'binary'>, binaryLabel: string): string {
  if (file.binary)
    return binaryLabel
  const insertions = file.insertions ?? 0
  const deletions = file.deletions ?? 0
  return `+${insertions} -${deletions}`
}

/** 汇总的 `+N -M` 文本。 */
export function formatTotals(totals: { insertions: number, deletions: number }): string {
  return `+${totals.insertions} -${totals.deletions}`
}

/**
 * 账本里是否已经有这一轮的记录（**任何**记录，包括「文件数为 0」与「不可用」）。
 *
 * 卡片的重试窗口只该盯住「账本还没有这一轮」，而不是「卡片暂时不可见」：
 * 前者是 after 快照还在后台结算（要等），后者可能是「这一轮确实没有改动」（等也没用，
 * 而且会把重试预算白白烧掉）。
 */
export function hasTurnRecord(summary: SessionSummary | null, turn: number | undefined): boolean {
  if (summary === null || turn === undefined)
    return false
  return summary.turns.some(item => item.turn === turn)
}

/**
 * 第 `attempt` 次重试（0 起）的等待时间：700ms 起指数退避、封顶 5s。
 * @param attempt - 已失败的重试次数。
 * @param baseMs - 首次等待。
 * @param maxMs - 单次等待上限。
 * @returns 毫秒。
 */
export function summaryRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const safe = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  return Math.min(baseMs * 2 ** safe, maxMs)
}

/** 文件名（单文件卡片的标题用它）。 */
export function basename(path: string): string {
  const segments = path.split('/')
  return segments.at(-1) ?? path
}

/**
 * 卡片状态判定（纯函数）。
 * @param summary - 该会话的摘要；null 表示尚未取到。
 * @param turn - 本轮 turn 号。
 * @returns 卡片应呈现的状态（`hidden` 表示不占位）。
 */
export function resolveCardState(summary: SessionSummary | null, turn: number | undefined): TurnCardState {
  if (turn === undefined || !Number.isInteger(turn) || turn <= 0)
    return { kind: 'hidden' }
  if (summary === null)
    return { kind: 'hidden' }
  if (!summary.isGit) {
    /*
      非 Git 仓库：**整张卡片都不出现**（需求：这类工作区里撤销本就不适用，却会在每一轮
      结尾弹一张「该工作区不是 Git 代码仓库」——用户什么都没改也会看到，纯属噪音）。

      例外是**可操作的诊断**：git 可执行文件缺失（`GIT_UNAVAILABLE`）、危险路径
      （家目录/盘根，`UNSAFE_WORKSPACE`）仍如实呈现——它们回答的是「为什么这个工作区
      不能撤销」，而 `GIT_REQUIRED` 回答的是「这里本来就没有仓库」，后者没有任何可做的
      事情，因此保持沉默。
    */
    return summary.unavailableReason !== null && summary.unavailableReason !== TURNREWIND_REASON_GIT_REQUIRED
      ? { kind: 'unavailable', reason: summary.unavailableReason }
      : { kind: 'hidden' }
  }
  const record = summary.turns.find(item => item.turn === turn)
  if (record === undefined)
    return { kind: 'hidden' }
  if (record.unavailable !== null && record.unavailable !== undefined) {
    /*
      「快照过程失败」是**通用内部失败**：没有文件明细、没有可操作指引。若这一轮连
      基线都没建立（hasBaseline === false），它从来没有过可撤销的承诺——用户中断、
      捕获子进程被回收、工作区 git 暂时报错都会落在这里，此时弹「撤销不可用」纯属惊扰
      （用户反馈：明明什么都没改，却看到一张写着内部错误码的告警卡片）。
      宿主侧仍然写日志，账本行也保留，诊断信息不丢；这里只是不打扰用户。

      其余原因一律照常呈现：超限类原因说明「这一轮超出撤销范围」，过期类说明
      「快照已被回收」——都是用户能理解、也可能需要采取行动的信息。
    */
    if (record.unavailable === TURNREWIND_REASON_SNAPSHOT_FAILED && record.hasBaseline === false)
      return { kind: 'hidden' }
    return { kind: 'failed', reason: record.unavailable }
  }
  if (record.files.length === 0)
    return { kind: 'hidden' }
  if (record.undoneAt !== null && record.undoneAt !== undefined)
    return { kind: 'undone', record }
  return { kind: 'ready', record }
}

/** 卡片标题：单文件用文件名，多文件用数量。 */
export function cardTitle(record: Pick<TurnSummary, 'files'>, one: (name: string) => string, many: (count: number) => string): string {
  if (record.files.length === 1)
    return one(basename(record.files[0]?.path ?? ''))
  return many(record.files.length)
}

/**
 * 文件清单的折叠窗口。
 *
 * `hiddenCount` 始终按**折叠态**计算：展开后按钮必须继续存在（否则用户无法收起），
 * 因此不能用「当前可见行数」反推被隐藏的数量。
 *
 * @param files - 本 turn 的全部变更文件。
 * @param expanded - 是否已展开。
 * @param limit - 折叠时显示的行数上限。
 * @returns 当前应渲染的行，以及折叠时会隐藏的行数。
 */
export function fileListWindow(
  files: readonly TurnFileChange[],
  expanded: boolean,
  limit: number,
): { visible: readonly TurnFileChange[], hiddenCount: number } {
  const collapsed = files.slice(0, limit)
  return {
    visible: expanded ? files : collapsed,
    hiddenCount: files.length - collapsed.length,
  }
}
