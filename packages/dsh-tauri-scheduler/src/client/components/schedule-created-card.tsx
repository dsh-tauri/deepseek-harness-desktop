import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { TaskView } from '../types'
import { Button, Card, Clock, Icon } from 'dsh-tauri-ui/client'
import { describeSchedule } from './schedule.utils'

export function ScheduleCreatedCard({ task, currentTask, openTaskDetail, t }: {
  readonly task: TaskView
  readonly currentTask: TaskView | null | undefined
  readonly openTaskDetail: (id: string) => void
  readonly t: Translate
}): ReactElement {
  const current = currentTask ?? task
  const deleted = currentTask === null
  return (
    <Card data-tool="scheduler_create" className="mx-0 max-w-[520px]">
      <Card.Header>
        <Card.Icon className="h-[32px] w-[32px] border-none"><Icon as={Clock} size={18} aria-hidden="true" /></Card.Icon>
        <Card.Content>
          <Card.TitleRow><Card.Title>{current.name}</Card.Title></Card.TitleRow>
          <Card.Description>{deleted ? t('ambient.card.deleted') : describeSchedule(current.schedule, t)}</Card.Description>
        </Card.Content>
        {!deleted && (
          <Card.End>
            <Button variant="outline" size="sm" aria-label={t('ambient.open', { name: current.name })} onClick={() => openTaskDetail(task.id)}>
              {t('ambient.card.open')}
            </Button>
          </Card.End>
        )}
      </Card.Header>
    </Card>
  )
}
