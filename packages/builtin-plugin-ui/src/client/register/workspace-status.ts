import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { postSessionWorkspaceStatus } from '../apis'
import { WorkspaceStatusNotice } from '../ui/workspace-status-notice'

const COMPOSER_DOCK_SLOT = 'conversation.composer.dock'

export const registerWorkspaceStatus = defineRegister<ClientContext>((controller, ctx, adapter) => {
  if (!('dshDesktop' in globalThis))
    return

  const notice = {
    checkWorkspace: (sessionId: string, signal: AbortSignal) => postSessionWorkspaceStatus({ sessionId }, { signal }),
    onWindowFocus: (refresh: () => void) => controller.listenWindow('focus', refresh),
    chooseFolder: () => adapter.addWorkspace({ openSession: true }),
  }

  controller.add(ctx.slots.inject(COMPOSER_DOCK_SLOT, () => ctx.slots.register({
    name: COMPOSER_DOCK_SLOT,
    id: 'workspace-status',
    registrant: PLUGIN_ID,
    inject: () => notice,
  }, WorkspaceStatusNotice)))
})
