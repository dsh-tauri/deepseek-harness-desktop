import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { ScheduleTurnOwner } from '../service/schedule-turn'
import { selectScheduleTasks } from '../service/schedule-turn'
import { ScheduleCurrentCards } from './schedule-current-cards'

export interface ScheduleTurnCardInjected {
  readonly openTaskDetail: (id: string) => void
}

export function ScheduleTurnCard(props: ScheduleTurnOwner & ScheduleTurnCardInjected & { t: Translate }): ReactElement | null {
  const matched = selectScheduleTasks(props)
  if (matched === null)
    return null
  const latest = matched.created[matched.created.length - 1]!
  return <ScheduleCurrentCards key={`${props.turn.turn}:${latest.callId}:${latest.seq}`} created={matched.created} openTaskDetail={props.openTaskDetail} t={props.t} />
}
