import type { DiscardCommand } from './use-discard.types'
import { useRef } from 'react'
import { DISCARD_MAX_POLLS, DISCARD_POLL_DELAY_MS } from '../constants'
import { discard, loadDiscardProgress } from '../service/worktree'
import { store } from '../store'
import { sessionStateOf } from '../store/modules/worktree.utils'
import { useWaiter } from './use-waiter'

export function useDiscard(sessionId: string | undefined): (input: { worktreeKey: string }) => Promise<DiscardCommand> {
  const { wait, mountedRef } = useWaiter()
  const pollingRef = useRef(false)

  return async (input: { worktreeKey: string }): Promise<DiscardCommand> => {
    if (!sessionId)
      return { ok: false, error: 'No current session.' }
    if (sessionStateOf(store.worktree.$state, sessionId).phase === 'deleting')
      return { ok: true }

    const started = await discard({ sessionId, worktreeKey: input.worktreeKey })
    if (!started.ok || !started.jobId)
      return started
    const jobId = started.jobId

    if (pollingRef.current)
      return { ok: true }
    pollingRef.current = true
    void (async (): Promise<void> => {
      try {
        for (let attempt = 0; attempt < DISCARD_MAX_POLLS; attempt++) {
          if (!mountedRef.current)
            return
          await wait(DISCARD_POLL_DELAY_MS)
          if (!mountedRef.current)
            return
          const progress = await loadDiscardProgress({ sessionId, jobId })
          if (progress !== 'deleting' && progress !== 'other')
            return
        }
      }
      finally {
        pollingRef.current = false
      }
    })()
    return { ok: true }
  }
}
