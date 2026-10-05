import type { ComposerSessionsRuntime } from '../register/composer-resume.types'

export type ForkRefusedSessionOutcome = { ok: true, childId: string } | { ok: false, error: string }

/**
 * Action：从原会话最后一个正常结束的回合边界分叉出子会话（原会话零改动）。
 *
 * 必须显式传 `atSeq`：内核省略该参数时取「最后一个 turn/end」，也就是把审核拒绝那一轮
 * 一起切进子会话，恢复后必然重蹈覆辙；边界由调用方从事件窗口取。
 */
export async function forkRefusedSession(input: {
  sessions: ComposerSessionsRuntime
  sessionId: string
  atSeq: number
}): Promise<ForkRefusedSessionOutcome> {
  const fork = input.sessions.fork
  if (typeof fork !== 'function')
    return { ok: false, error: '会话分叉能力缺席' }
  try {
    const childId = await fork.call(input.sessions, {
      sessionId: input.sessionId,
      atSeq: input.atSeq,
      increaseTitle: true,
    })
    if (typeof childId !== 'string' || childId.length === 0)
      return { ok: false, error: '会话分叉未返回子会话 id' }
    return { ok: true, childId }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
