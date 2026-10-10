import { get, isString } from 'lodash-es'
import { injectedCheckoutContexts } from '../config/runtime'
import { checkoutContext } from '../service/checkout-context'
import { worktreeTitle } from '../service/title'
import { worktree } from '../service/worktree'

export function handleSessionEvent(session: any, event: any): void {
  // 首个请求头落盘时就补标题：与内核自动生成的时机一致，官方按该请求的路由生成。
  if (event?.type === 'request/header') {
    void worktreeTitle.refresh(session)
    return
  }
  if (event?.type !== 'turn/end')
    return
  const sessionId = get(session, 'id')
  if (!isString(sessionId))
    return

  void worktree.recover()

  if (injectedCheckoutContexts.delete(sessionId))
    void checkoutContext.remove(sessionId)
}
