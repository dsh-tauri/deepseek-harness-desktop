import type { HostContext } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { get, isString } from 'lodash-es'
import { pendingWorktreeTitles } from '../config/runtime'
import { server } from '../server'

function hostInstance(): any {
  try {
    return getServerContext<HostContext>(server)
  }
  catch {
    return undefined
  }
}

export const worktreeTitle = defineService({
  async refresh(session: unknown): Promise<void> {
    const sessionId = get(session, 'id')
    if (!isString(sessionId) || !pendingWorktreeTitles.delete(sessionId))
      return
    try {
      await hostInstance()?.get?.('sessionTitle')?.refresh?.(session)
    }
    catch (error) {
      hostInstance()?.logger?.warn?.(`dsh-tauri-worktree: worktree session title failed for ${sessionId}: ${get(error, 'message', String(error))}`)
    }
  },
})
