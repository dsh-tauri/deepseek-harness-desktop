import type { ClientContext } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { TaskTabNavigation } from '../types/task-tab'
import { Button, Card, CommentPlus, Icon, Input, Magnifier, Panel, Plus, Text } from 'dsh-tauri-ui/client'
import { filter, includes, isEmpty, lowerCase, useStore } from 'dsh-tauri/client'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { store } from '../store'
import { Recommendations } from './recommendations'
import { describeSchedule, formatRelative } from './schedule.utils'
import { TaskCard } from './task-card'
import { TaskDetail } from './task-detail'

interface SchedulerPanelProps {
  t: Translate
  onViaChat: () => void
  sessionsRuntime: Pick<ClientContext['sessions'], 'list'>
  workspacesRuntime: Pick<ClientContext['workspaces'], 'list'>
  openHistorySession: (id: string) => Promise<{ ok: boolean, error?: string }>
}

export function SchedulerPanel({ t, onViaChat, sessionsRuntime, workspacesRuntime, openHistorySession }: SchedulerPanelProps): ReactElement {
  const state = useStore(store.scheduler)
  const navigation = useStore(store.navigation)
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<TaskTabNavigation>()
  const sessionsSource = useMemo(() => ({ subscribe: sessionsRuntime.list.subscribe.bind(sessionsRuntime.list), getSnapshot: sessionsRuntime.list.getSnapshot.bind(sessionsRuntime.list) }), [sessionsRuntime.list])
  const workspacesSource = useMemo(() => ({ subscribe: workspacesRuntime.list.subscribe.bind(workspacesRuntime.list), getSnapshot: workspacesRuntime.list.getSnapshot.bind(workspacesRuntime.list) }), [workspacesRuntime.list])
  const sessions = useSyncExternalStore(sessionsSource.subscribe, sessionsSource.getSnapshot)
  const workspaces = useSyncExternalStore(workspacesSource.subscribe, workspacesSource.getSnapshot)
  const filtered = filter(state.tasks, task =>
    isEmpty(search) || includes(lowerCase(`${task.name} ${task.prompt}`), lowerCase(search)))

  return (
    <section
      className="flex w-full h-full min-w-0 min-h-0 overflow-hidden bg-[var(--dsw-alias-bg-base)]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !store.deletion.pendingTask) {
          event.preventDefault()
          setTarget(undefined)
        }
      }}
    >
      <div className={target ? 'flex-1 min-w-0 min-h-0 max-[760px]:hidden' : 'flex-1 min-w-0 min-h-0'}>
        <Panel>
          <div className="box-border font-sans text-primary text-[13px] leading-[1.5]">
            <header className="flex justify-between items-start gap-[16px] mb-[12px]">
              <div className="min-w-0">
                <h1 className="m-0 text-[20px] leading-[28px] font-medium">{t('scheduler')}</h1>
                <p className="mt-[4px] mx-0 mb-0 text-secondary text-[13px] leading-[20px]">{t('subtitle')}</p>
              </div>
              <div className="flex justify-end items-center gap-[16px]">
                <Button style={{ flexShrink: 0 }} variant="addGhost" icon={<Icon as={CommentPlus} />} onClick={onViaChat}>
                  {t('viaChat')}
                </Button>
                <Button style={{ flexShrink: 0 }} variant="add" icon={<Icon as={Plus} size={13} />} onClick={() => setTarget({ draft: true })}>
                  {t('createManual')}
                </Button>
              </div>
            </header>

            <div className="flex justify-between items-center mb-[12px]">
              <Input
                className="flex-[0_1_280px] min-w-0 max-w-[280px] max-[680px]:max-w-[160px]"
                type="search"
                icon={<Icon as={Magnifier} />}
                aria-label={t('searchPlaceholder')}
                placeholder={t('searchPlaceholder')}
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
            </div>

            {state.error ? <Text tone="error" role="alert">{state.error}</Text> : null}
            {navigation.error ? <Text tone="error" role="alert">{navigation.error}</Text> : null}
            {filtered.length === 0
              ? <Text size="sm" tone="tertiary" className="py-[48px] text-center">{search ? t('noMatch') : t('emptyTasks')}</Text>
              : (
                  <Card.List className="gap-[8px]">
                    {filtered.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        t={t}
                        describe={describeSchedule(task.schedule, t)}
                        nextRun={task.enabled && task.status === 'active' ? formatRelative(task.nextRunAt, state.refreshedAt, t) : undefined}
                        paused={!task.enabled}
                        onEdit={task => setTarget({ id: task.id, sessionId: task.sessionId })}
                      />
                    ))}
                  </Card.List>
                )}
            <Recommendations t={t} tasks={state.tasks} onSelect={initial => setTarget({ draft: true, initial })} />
          </div>
        </Panel>
      </div>
      {target
        ? (
            <div className="flex flex-[0_0_47%] min-w-0 min-h-0 border-l-[0.5px] border-border-l4 max-[760px]:flex-1 max-[760px]:border-l-0">
              <TaskDetail key={target.draft ? `draft/${target.initial?.recommendationId ?? ''}` : target.id} target={target} t={t} sessions={sessions} workspaces={workspaces} onClose={() => setTarget(undefined)} onNavigate={setTarget} openHistorySession={openHistorySession} />
            </div>
          )
        : null}
    </section>
  )
}
