import { recordTurnEnd } from '../service/turn-end'

/**
 * `session/event` 订阅：只挑 `turn/end` 记下结束原因。
 *
 * 事件回调签名是 `(session, event)`（与 `dsh-tauri-worktree`、`dsh-tauri-pet` 一致），
 * 会话 id 取 `session.id`。原因缺失时记成空原因而不是直接返回：空原因在客户端不算中断，
 * 于是退化成「照常通知」；直接返回会把上一回合的旧原因留在表里，那个旧原因若是 `aborted`，
 * 就会把这一回合的通知也一并吞掉。
 */
export function handleSessionEvent(session: any, event: any): void {
  if (event?.type !== 'turn/end')
    return
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return
  const reason = event?.data?.reason?.kind
  const turn = event?.data?.turn
  recordTurnEnd(sessionId, {
    reason: typeof reason === 'string' ? reason : '',
    turn: typeof turn === 'number' ? turn : -1,
  })
}
