import type { SessionsRuntime } from '../service/session-switch.types'
import { useCallback, useSyncExternalStore } from 'react'

export function useCurrentSession(sessions: Pick<SessionsRuntime, 'list'>): string | undefined {
  const subscribe = useCallback((listener: () => void) => sessions.list.subscribe(listener), [sessions])
  const getSnapshot = useCallback(() => sessions.list.getSnapshot().current, [sessions])
  return useSyncExternalStore(subscribe, getSnapshot)
}
