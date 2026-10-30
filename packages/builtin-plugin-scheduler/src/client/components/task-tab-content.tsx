import type { ReactElement } from 'react'
import type { TaskTabInfo } from '../types/task-tab'
import type { TaskTabProps } from './task-tab'
import { useWatchImmediate } from 'dsh-tauri/client'
import { SCHEDULE_TASK_KIND } from '../constants'
import { useTaskTabTarget } from '../hooks/use-task-tab-target'
import { TaskDetail } from './task-detail'

export function TaskTabContent(props: TaskTabProps & { tab: TaskTabInfo['tab'] }): ReactElement {
  const { sessionId, tab, taskBindings, t, openHistorySession } = props
  const { navigated, navigation, recovered, params } = useTaskTabTarget(sessionId, tab, taskBindings)
  const sessions = props.useSessions(value => value)
  const workspaces = props.useWorkspaces(value => value)
  useWatchImmediate([navigation?.draft, navigation && !navigation.draft ? navigation.id : undefined, navigation?.sessionId], () => {
    if (navigation?.draft)
      taskBindings.forget(sessionId, tab)
    else if (navigation)
      taskBindings.write(sessionId, tab, navigation)
  })
  return (
    <TaskDetail
      target={params}
      withinSession={sessionId}
      t={t}
      sessions={sessions}
      workspaces={workspaces}
      onClose={tab.actions.close}
      onNavigate={target => tab.actions.openTab(SCHEDULE_TASK_KIND, { params: target })}
      onMissing={() => {
        if (!navigated && recovered)
          taskBindings.forget(sessionId, tab)
      }}
      openHistorySession={openHistorySession}
    />
  )
}
