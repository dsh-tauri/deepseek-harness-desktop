import { get, isString } from 'lodash-es'
import { WORKTREE_SECTION_ORDER } from '../../shared/constants'
import { injectedCheckoutContexts } from '../config/runtime'
import { checkoutContext } from '../service/checkout-context'

export const checkoutContextProvider = {
  name: 'plugin:dsh-tauri-worktree:checkout',
  order: WORKTREE_SECTION_ORDER,
  text(context: any): string {
    const sessionId = get(context, 'scope.session.id')
    if (!isString(sessionId))
      return ''
    const checkout = checkoutContext.load(sessionId)
    if (!checkout)
      return ''
    injectedCheckoutContexts.add(sessionId)
    return (
      `Worktree checkout completed.\n`
      + `is_worktree: false\n`
      + `Removed worktree: ${checkout.worktreePath ?? 'unknown'}\n`
      + `Current local project directory: ${checkout.projectPath}\n`
      + `Current local branch: ${checkout.branch ?? 'unknown'}\n\n`
      + `Continue this request in the local project directory. Do not use the removed worktree path.`
    )
  },
}
