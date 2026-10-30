import type { PlanSession } from '../service/session.types'
import { session } from '../service/session'

export async function handlePreStep(payload: { agent: { session: PlanSession }, step: number, signal: AbortSignal }, next: () => Promise<unknown>): Promise<unknown> {
  const decision = await next()
  const admitted = decision as { kind?: string, messages?: unknown } | undefined
  if (!payload.signal.aborted && admitted?.kind === 'enter' && Array.isArray(admitted.messages))
    session.restorePlan(payload.agent.session, admitted.messages, payload.step)
  return decision
}
