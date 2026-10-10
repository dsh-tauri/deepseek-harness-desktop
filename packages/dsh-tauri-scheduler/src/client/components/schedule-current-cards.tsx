import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { ScheduleCreatedTask } from '../service/schedule-turn'
import { Card } from 'dsh-tauri-ui/client'
import { useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useState } from 'react'
import { loadScheduler } from '../service/scheduler'
import { store } from '../store'
import { ScheduleCreatedCard } from './schedule-created-card'

export function ScheduleCurrentCards({ created, openTaskDetail, t }: {
  readonly created: readonly ScheduleCreatedTask[]
  readonly openTaskDetail: (id: string) => void
  readonly t: Translate
}): ReactElement {
  const catalog = useStore(store.scheduler)
  const [requestAtMount] = useState(() => store.scheduler.loadToken)
  useWatchImmediate(requestAtMount, () => void loadScheduler())
  const records = catalog.successfulReadToken > requestAtMount ? catalog.tasks : undefined
  return (
    <Card.List className="my-[8px] gap-[8px]">
      {created.map(result => (
        <ScheduleCreatedCard
          key={result.callId}
          task={result.task}
          currentTask={records?.find(task => task.id === result.task.id) ?? (records === undefined ? undefined : null)}
          openTaskDetail={openTaskDetail}
          t={t}
        />
      ))}
    </Card.List>
  )
}
