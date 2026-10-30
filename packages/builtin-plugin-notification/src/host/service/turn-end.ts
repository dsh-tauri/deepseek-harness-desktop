import type { HostContext } from 'dsh-tauri'
import { getServerContext } from 'dsh-h3/utils'
import { server } from '../server'

/** 单个会话最近一次 `turn/end` 的结束事实。 */
export interface TurnEndFact {
  /** `turn/end` 的 `reason.kind`，例如 `completed` / `aborted`。 */
  readonly reason: string
  /** 该原因所属的回合号；宿主没有给出时是 `-1`。 */
  readonly turn: number
}

/** sessionId → 最近一次回合结束事实（内存态，不落盘）。 */
const facts = new Map<string, TurnEndFact>()

export function recordTurnEnd(sessionId: string, fact: TurnEndFact): void {
  facts.set(sessionId, fact)
}

export function turnEndFact(sessionId: string): TurnEndFact | undefined {
  const archivedSessionIds: readonly string[] | undefined = getServerContext<HostContext>(server).workspaceRegistry?.archivedSessionIds
  if (archivedSessionIds?.includes(sessionId))
    return { reason: 'archived', turn: facts.get(sessionId)?.turn ?? -1 }
  return facts.get(sessionId)
}

export function clearTurnEndFacts(): void {
  facts.clear()
}
