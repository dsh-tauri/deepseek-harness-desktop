import type { NotifyTrigger } from '../types/index'
import { getTurnEnd } from '../apis/index'

export async function turnEndReason(sessionId: string): Promise<string> {
  if (sessionId.length === 0)
    return ''
  try {
    const fact = await getTurnEnd({ sessionId })
    return typeof fact?.reason === 'string' ? fact.reason : ''
  }
  catch {
    return ''
  }
}

export async function resolveTrigger(sessionId: string): Promise<NotifyTrigger> {
  const reason = await turnEndReason(sessionId)
  return reason === '' || reason === 'completed' ? 'completed' : 'abnormal'
}
