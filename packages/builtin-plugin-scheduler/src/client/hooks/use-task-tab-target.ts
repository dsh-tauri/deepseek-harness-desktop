import type { TaskTabBindings } from '../service/task-tab-bindings'
import type { TaskTabInfo } from '../types/task-tab'
import { useWatchImmediate } from 'dsh-tauri/client'
import { useMemo } from 'react'
import { taskTabParams } from '../service/task-tab-bindings'

export function useTaskTabTarget(sessionId: string, tab: TaskTabInfo['tab'], taskBindings: TaskTabBindings) {
  const navigated = tab.navigation.params !== undefined
  const navigation = taskTabParams(tab.navigation.params)
  const recovered = useMemo(
    () => navigated ? undefined : taskBindings.read(sessionId, { id: tab.id, kind: tab.kind, contentId: tab.contentId }),
    [taskBindings, sessionId, tab.id, tab.kind, tab.contentId, navigated],
  )
  useWatchImmediate([sessionId, tab.id, tab.kind, tab.contentId, navigated, tab.navigation.revision], () => {
    if (!navigated)
      taskBindings.dropMismatched(sessionId, tab)
  })
  return { navigated, navigation, recovered, params: navigated ? navigation : recovered }
}
