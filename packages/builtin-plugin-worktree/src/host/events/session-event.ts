import { get, isString } from 'lodash-es'
import { injectedCheckoutContexts } from '../config/runtime'
import { checkoutContext } from '../service/checkout-context'
import { worktreeTitle } from '../service/title'
import { worktree } from '../service/worktree'

export function handleSessionEvent(session: any, event: any): void {
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
