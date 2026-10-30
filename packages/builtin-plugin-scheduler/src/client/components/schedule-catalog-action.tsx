import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { ScheduleTurnCardInjected } from './schedule-turn-card'
import { Action, Button, Clock, Icon, Menu, TrashBin } from 'dsh-tauri-ui/client'
import { useStore, useTimeoutPoll, useWatchImmediate } from 'dsh-tauri/client'
import { useState } from 'react'
import { requestTaskDeletion } from '../service/deletion'
import { activeSessionTasks, isTaskOverdue, orderSessionTasks } from '../service/session-schedule'
import { store } from '../store'
import { ScheduleTaskTiming } from './schedule-task-timing'

export interface ScheduleCatalogActionInjected extends ScheduleTurnCardInjected {
  readonly sessionId: string
}

export function ScheduleCatalogAction({ sessionId, openTaskDetail, t }: ScheduleCatalogActionInjected & { t: Translate }): ReactElement | null {
  const catalog = useStore(store.scheduler)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const clock = useTimeoutPoll(() => setNow(Date.now()), 1000, { immediate: false })
  useWatchImmediate(open, () => open ? clock.resume() : clock.pause())
  const tasks = orderSessionTasks(activeSessionTasks(catalog.tasks, sessionId), now)
  useWatchImmediate([sessionId, tasks.length], () => setOpen(false))
  if (tasks.length === 0)
    return null
  const multiple = tasks.length > 1
  const label = t(multiple ? 'ambient.trigger.other' : 'ambient.trigger.one', { count: tasks.length })
  return (
    <Menu
      open={multiple && open}
      onClose={() => setOpen(false)}
      align="end"
      portal
      autoFocus
      listClassName="w-[336px] max-w-[calc(100vw-32px)] max-h-[min(420px,calc(100dvh-48px))] p-[3px] rounded-[16px]"
      anchor={(
        <Action
          variant="round"
          className="ml-[4px] rounded-full text-tertiary"
          icon={<Icon as={Clock} size={16} aria-hidden="true" />}
          aria-label={label}
          title={label}
          aria-haspopup={multiple ? 'menu' : undefined}
          aria-expanded={multiple ? open : undefined}
          onClick={() => {
            if (!multiple) {
              openTaskDetail(tasks[0]!.id)
              return
            }
            setNow(Date.now())
            setOpen(value => !value)
          }}
        />
      )}
    >
      <div aria-label={t('ambient.list.aria')}>
        {tasks.map(task => (
          <div key={task.id} data-overdue={isTaskOverdue(task, now) || undefined} className="flex min-w-0 items-start gap-[8px] rounded-[13px] pr-[6px] hover:bg-hover focus-within:bg-hover">
            <Button
              variant="link"
              role="menuitem"
              className="flex-1 min-w-0 min-h-[48px] items-start justify-start text-primary text-left px-[12px] py-[10px] rounded-[13px] no-underline hover:no-underline"
              aria-label={t('ambient.open', { name: task.name })}
              onClick={() => {
                setOpen(false)
                openTaskDetail(task.id)
              }}
            >
              <span className="flex flex-col gap-[2px] min-w-0 flex-1">
                <span className="block whitespace-normal wrap-anywhere text-[13px] leading-[18px]">{task.name}</span>
                <ScheduleTaskTiming task={task} now={now} t={t} variant="menu" />
              </span>
            </Button>
            <Action
              variant="round"
              className="w-[20px] h-[20px] mt-[8px] rounded-full"
              role="menuitem"
              aria-label={`${t('delete')} ${task.name}`}
              title={t('delete')}
              icon={<Icon as={TrashBin} size={14} aria-hidden="true" />}
              onClick={() => {
                setOpen(false)
                requestTaskDeletion(task)
              }}
            />
          </div>
        ))}
      </div>
    </Menu>
  )
}
