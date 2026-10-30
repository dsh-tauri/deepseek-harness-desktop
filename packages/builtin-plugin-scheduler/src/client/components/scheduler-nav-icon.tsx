import type { ReactElement } from 'react'
import { Clock, Dot, Icon } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { store } from '../store'
import { countUnreadRuns } from './schedule.utils'

export function SchedulerNavIcon({ size }: { size: number }): ReactElement {
  const state = useStore(store.scheduler)
  return (
    <>
      <Icon as={Clock} size={size} />
      {countUnreadRuns(state.runs, state.readAt, state.readIds) > 0
        ? <Dot className="dshp-scheduler__nav-dot absolute right-[8px] top-1/2 -translate-y-1/2" state="done" />
        : null}
    </>
  )
}
