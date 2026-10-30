import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import { Clock, Icon } from 'dsh-tauri-ui/client'
import { useStore, useTimeoutPoll } from 'dsh-tauri/client'
import { useState } from 'react'
import { activeSessionTasks, isTaskOverdue, orderSessionTasks } from '../service/session-schedule'
import { store } from '../store'
import { ScheduleTaskTiming } from './schedule-task-timing'

interface SessionScheduleProps {
  readonly sessionId: string
  readonly t: Translate
}

export function SessionScheduleHover({ sessionId, t }: SessionScheduleProps): ReactElement | null {
  const catalog = useStore(store.scheduler)
  const [now, setNow] = useState(() => Date.now())
  useTimeoutPoll(() => setNow(Date.now()), 1000)
  const tasks = orderSessionTasks(activeSessionTasks(catalog.tasks, sessionId), now)
  if (tasks.length === 0)
    return null
  const shown = tasks.slice(0, 2)
  const omitted = tasks.length - shown.length
  return (
    <section data-session-schedule-tasks="" aria-label={t('ambient.list.aria')} className="flex flex-col gap-[8px]">
      {shown.map(task => (
        <div key={task.id} className="flex min-w-0 gap-[6px]" data-session-schedule-task="" data-overdue={isTaskOverdue(task, now) || undefined}>
          <Icon as={Clock} size={12} aria-hidden="true" className="mt-[2px] shrink-0 text-[#CFD3D6]" />
          <span className="flex flex-col gap-[2px] min-w-0 flex-1">
            <span className="block whitespace-normal wrap-anywhere text-[12px] leading-[16px] text-white">{task.name}</span>
            <ScheduleTaskTiming task={task} now={now} t={t} variant="hover" />
          </span>
        </div>
      ))}
      {omitted > 0 && <span className="text-[12px] leading-[16px] text-[#ADB2B8]">{t('ambient.hover.more', { count: omitted })}</span>}
    </section>
  )
}
