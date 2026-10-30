import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import { Alarm, Clock, Icon } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { SESSION_SCHEDULE_ORIGIN_PROJECTION } from '../../shared/constants'
import { activeSessionTasks } from '../service/session-schedule'
import { store } from '../store'

export function SessionScheduleMark({ sessionId, useSessions, t }: { sessionId: string, t: Translate } & Partial<Pick<GlobalStandardProps, 'useSessions'>>): ReactElement | null {
  const catalog = useStore(store.scheduler)
  const tasks = activeSessionTasks(catalog.tasks, sessionId)
  const scheduledOrigin = useSessions?.(sessions => sessions.byId[sessionId as SessionId]?.projectionValues?.[SESSION_SCHEDULE_ORIGIN_PROJECTION] === true) ?? false
  if (tasks.length === 0 && !scheduledOrigin)
    return null
  const label = tasks.length > 0 ? t('ambient.mark.aria', { count: tasks.length }) : t('ambient.mark.origin.aria')
  return (
    <span
      data-session-schedule-mark=""
      className="inline-flex h-[20px] w-[16px] shrink-0 items-center justify-center text-tertiary"
      onClick={event => event.stopPropagation()}
    >
      <Icon as={tasks.length > 0 ? Alarm : Clock} size={16} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
}
