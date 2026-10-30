import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { TaskTabBindings } from '../service/task-tab-bindings'
import { TaskTabContent } from './task-tab-content'

export interface TaskTabInjected {
  t: Translate
  taskBindings: TaskTabBindings
  openHistorySession: (id: string) => Promise<{ ok: boolean, error?: string }>
}

export type TaskTabProps = PropsRuntime<'sidebar.right.pane.tab'> & TaskTabInjected

export function TaskTab(props: TaskTabProps): ReactElement {
  const { tab } = props.useTabInfo()
  return <TaskTabContent key={`${props.sessionId}/${tab.id}/${tab.navigation.revision}`} {...props} tab={tab} />
}
