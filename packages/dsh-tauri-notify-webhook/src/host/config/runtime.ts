export interface TurnEndFact {
  reason: string
  turn: number
}

/** sessionId → 最近一次 `turn/end` 的结束事实（内存态，不落盘）。 */
export const turnEndFacts = new Map<string, TurnEndFact>()

export function resetRuntime(): void {
  turnEndFacts.clear()
}
