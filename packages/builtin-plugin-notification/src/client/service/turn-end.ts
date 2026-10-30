import { getTurnEnd } from '../apis'

/**
 * 用户主动中断会话时 `turn/end` 的 `reason.kind`。
 *
 * 内核把手动中断标成 `aborted`（`completed` 才是正常跑完）；`interrupted` 是同类语义的
 * 历史别名，一并认掉：两者都不该弹「回合完成」通知。
 */
const USER_INTERRUPT_REASONS: ReadonlySet<string> = new Set(['aborted', 'interrupted', 'archived'])

/**
 * 这个会话最近一次回合是不是被用户手动中断的。
 *
 * 宿主没应答时返回 `false`：路由缺席（旧宿主）、连接失败都只该退化成「照常通知」，
 * 漏一条通知比吞掉一条通知更糟。因此只有宿主明确给出中断原因才算数。
 */
export async function turnEndedByUser(sessionId: string): Promise<boolean> {
  if (sessionId.length === 0)
    return false
  try {
    const fact = await getTurnEnd({ sessionId })
    return typeof fact?.reason === 'string' && USER_INTERRUPT_REASONS.has(fact.reason)
  }
  catch {
    return false
  }
}
