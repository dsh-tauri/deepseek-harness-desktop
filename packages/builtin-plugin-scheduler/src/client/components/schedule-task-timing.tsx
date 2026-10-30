import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { TaskView } from '../types'
import { isTaskOverdue } from '../service/session-schedule'
import { describeSchedule, formatLocalTime, formatRelative } from './schedule.utils'

export function ScheduleTaskTiming({ task, now, t, variant = 'menu' }: { task: TaskView, now: number, t: Translate, variant?: 'menu' | 'hover' }): ReactElement {
  const overdue = isTaskOverdue(task, now)
  const absolute = formatLocalTime(task.nextRunAt)
  return (
    <span className={variant === 'hover' ? 'flex flex-col gap-[2px] text-[12px] leading-[16px]' : 'flex flex-col gap-[2px] text-[10px] leading-[15px]'}>
      <span className={variant === 'hover' ? 'text-[#CFD3D6]' : 'text-tertiary'}>{describeSchedule(task.schedule, t)}</span>
      <span className={variant === 'hover' ? 'text-[#ADB2B8]' : 'text-tertiary'}>
        {absolute === undefined
          ? t('waiting')
          : (
              <>
                <time dateTime={task.nextRunAt}>{absolute}</time>
                {' '}
                <span className={overdue ? 'text-error' : undefined}>
                  {overdue ? t('ambient.overdue') : formatRelative(task.nextRunAt, now, t)}
                </span>
              </>
            )}
      </span>
    </span>
  )
}
