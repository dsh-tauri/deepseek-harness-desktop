import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import type { TaskTabInjected } from './task-tab'
import { Clock, Icon } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { useTaskTabTarget } from '../hooks/use-task-tab-target'
import { store } from '../store'

export function TaskTabTitle({ sessionId, useTabInfo, taskBindings, t }: PropsRuntime<'sidebar.right.pane.tab.title'> & TaskTabInjected): ReactElement {
  const { tab } = useTabInfo()
  const { params } = useTaskTabTarget(sessionId, tab, taskBindings)
  const { tasks } = useStore(store.scheduler)
  const task = params && !params.draft ? tasks.find(item => item.id === params.id) : undefined
  return (
    <>
      <Icon as={Clock} size={16} className="shrink-0 text-secondary" />
      <span>{params?.draft ? t('createDialogTitle') : task?.name ?? t('editDialogTitle')}</span>
    </>
  )
}
