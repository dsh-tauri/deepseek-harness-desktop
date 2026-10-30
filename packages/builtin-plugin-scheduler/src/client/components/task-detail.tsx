import type { SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { TaskView } from '../types'
import type { TaskTabNavigation } from '../types/task-tab'
import { Action, Button, ChevronRight, Clock, Ellipsis, Icon, Menu, SegmentedControl, Text, TrashBin, Xmark } from 'dsh-tauri-ui/client'
import { cloneDeep, cn, useMount, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useId, useState } from 'react'
import { requestTaskDeletion } from '../service/deletion'
import { loadOptions, loadScheduler } from '../service/scheduler'
import { store } from '../store'
import { DeliveryHistory } from './delivery-history'
import { Recommendations } from './recommendations'
import { sessionLabel, sessionLinkState } from './session-link'
import { TaskForm } from './task-form'

interface TaskDetailProps {
  target?: TaskTabNavigation
  withinSession?: string
  t: Translate
  sessions: SessionListState
  workspaces: WorkspaceSnapshot
  onClose: () => void
  onNavigate: (target: TaskTabNavigation) => void
  onMissing?: () => void
  openHistorySession: (id: string) => Promise<{ ok: boolean, error?: string }>
}

export function TaskDetail({ target, withinSession, t, sessions, workspaces, onClose, onNavigate, onMissing, openHistorySession }: TaskDetailProps): ReactElement {
  const state = useStore(store.scheduler)
  const deletion = useStore(store.deletion)
  const id = useId()
  const [view, setView] = useState<'rule' | 'records'>('rule')
  const [menuOpen, setMenuOpen] = useState(false)
  const [baseline] = useState(() => store.scheduler.loadToken)
  const [feedbackBaseline] = useState(() => store.deletion.feedbackSeq)
  const [optionsReady, setOptionsReady] = useState(false)
  const [openError, setOpenError] = useState('')
  const [savedRevision, setSavedRevision] = useState(0)
  const record = target && !target.draft ? state.tasks.find(task => task.id === target.id) : undefined
  const [retained, setRetained] = useState<TaskView | undefined>(() => record ? cloneDeep(record) : undefined)
  const answered = state.successfulReadToken > baseline
  const task = retained ?? record
  const inactive = record?.status === 'inactive' || task?.status === 'inactive'

  useMount(() => {
    void loadScheduler()
    void loadOptions().then(() => setOptionsReady(true)).catch(error => setOpenError(error instanceof Error ? error.message : String(error)))
  })
  useWatchImmediate(record, () => {
    if (!retained && record)
      setRetained(cloneDeep(record))
  })
  useWatchImmediate([answered, record !== undefined], () => {
    if (answered && !record && !target?.draft)
      onMissing?.()
  })
  useWatchImmediate(deletion.feedbackSeq, () => {
    if (task && deletion.feedback?.seq && deletion.feedback.seq > feedbackBaseline && deletion.feedback.kind === 'deleted' && deletion.feedback.taskId === task.id)
      onClose()
  })

  async function openSession(sessionId: string): Promise<void> {
    const result = await openHistorySession(sessionId)
    setOpenError(result.ok ? '' : result.error ?? t('openRunFailed'))
  }

  if (!target || (!target.draft && !task)) {
    return (
      <div className="flex flex-1 h-full min-h-0 flex-col items-center justify-center gap-[16px] p-[24px]">
        <Icon as={Clock} size={24} className="text-tertiary" />
        <Text size="sm" tone={state.error ? 'error' : 'secondary'} role="status">{answered ? t(target ? 'task.missing' : 'task.unbound') : state.error || t('loading')}</Text>
        <Button variant="outline" onClick={() => void loadScheduler()}>{t('refresh')}</Button>
        {!withinSession ? <Button variant="ghost" onClick={onClose}>{t('close')}</Button> : null}
      </div>
    )
  }

  const linkedId = task?.delivery === 'this-session' ? task.sessionId : undefined
  const link = linkedId ? sessionLinkState(linkedId, sessions, workspaces) : undefined
  const showLink = view === 'rule' && linkedId && linkedId !== withinSession
  const feedback = (
    <>
      {state.error ? <Text tone="error" role="alert">{state.error}</Text> : null}
      {openError ? <Text tone="error" role="alert">{openError}</Text> : null}
      {inactive && task?.status !== 'inactive' ? <Text tone="secondary">{t('task.inactive')}</Text> : null}
      {task && answered && !record ? <Text tone="error" role="status">{t('task.missing')}</Text> : null}
    </>
  )
  const recommendations = target.draft ? <Recommendations t={t} tasks={state.tasks} onSelect={initial => onNavigate({ draft: true, sessionId: target.sessionId ?? withinSession, initial })} /> : undefined
  const history = task && view === 'records' ? <DeliveryHistory taskId={task.id} refreshKey={record?.lastRunAt} timeZone={task.schedule.timeZone} t={t} sessions={sessions} workspaces={workspaces} onOpenSession={sessionId => void openSession(sessionId)} /> : undefined
  return (
    <aside aria-label={target.draft ? t('createDialogTitle') : task?.name} className="relative flex flex-1 flex-col h-full min-w-0 min-h-0 bg-[var(--dsw-alias-bg-base)] text-primary [--detail-gutter:24px] max-[1100px]:[--detail-gutter:20px] max-[400px]:[--detail-gutter:16px]">
      <h2 className="sr-only">{target.draft ? t('createDialogTitle') : task?.name}</h2>
      <div className={cn('box-border flex shrink-0 items-center justify-between gap-[20px] px-[var(--detail-gutter)] border-b-[0.5px] border-border-l3', withinSession ? 'h-[37px] min-h-[37px]' : 'h-[44px] min-h-[44px]')}>
        <SegmentedControl id={id} variant="underline" label={t('detail.tabs')} value={view} options={[{ value: 'rule', label: t('detail.rule') }, ...(!target.draft ? [{ value: 'records', label: t('detail.records') }] : [])]} onChange={value => setView(value === 'records' ? 'records' : 'rule')} />
        <div className={cn('flex shrink-0 items-center gap-[8px] max-[400px]:gap-0', withinSession ? 'mr-[calc(6px-var(--detail-gutter))]' : 'mr-[-8px]')}>
          {showLink && link
            ? (
                <Button variant="ghost" size="sm" className="h-[28px] px-[8px] rounded-[14px] text-secondary text-[13px] max-w-[200px] min-w-0" disabled={link !== 'available'} aria-label={`${t('session.link')}: ${sessionLabel(linkedId, sessions).text}`} title={sessionLabel(linkedId, sessions).text} onClick={() => void openSession(linkedId)}>
                  <span className="truncate">{t('session.link')}</span>
                  <Icon as={ChevronRight} size={14} />
                </Button>
              )
            : null}
          {task
            ? (
                <Menu
                  open={menuOpen}
                  onClose={() => setMenuOpen(false)}
                  align="end"
                  portal
                  items={[{ id: 'delete', label: t('delete'), icon: <Icon as={TrashBin} />, danger: true, disabled: !record || deletion.deletingTaskId === task.id }]}
                  onSelect={() => {
                    setMenuOpen(false)
                    requestTaskDeletion(task)
                  }}
                  anchor={<Action variant="round" className="text-tertiary" icon={<Icon as={Ellipsis} size={16} />} aria-label={t('detail.more')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)} />}
                />
              )
            : null}
          {!withinSession ? <Action variant="round" icon={<Icon as={Xmark} size={16} />} aria-label={t('close')} onClick={onClose} /> : null}
        </div>
      </div>
      {optionsReady
        ? (
            <TaskForm
              key={savedRevision}
              t={t}
              task={task}
              currentTask={record}
              initial={target.draft ? target.initial : undefined}
              options={state.options}
              sessions={sessions}
              workspaces={workspaces}
              defaultSessionId={target.sessionId ?? withinSession ?? sessions.ids[0] ?? ''}
              disabled={!!task && (inactive || (answered && !record))}
              id={id}
              view={view}
              feedback={feedback}
              onClose={onClose}
              onSaved={(saved) => {
                setRetained(cloneDeep(saved))
                setSavedRevision(value => value + 1)
                onNavigate({ id: saved.id, sessionId: saved.sessionId })
              }}
              recommendations={recommendations}
              history={history}
            />
          )
        : (
            <div className="flex flex-1 min-h-0 flex-col gap-[8px] p-[24px]">
              {feedback}
              <Text tone="secondary">{t('loading')}</Text>
              {recommendations}
              {history}
            </div>
          )}
      {showLink && link !== 'available' ? <Text role="status" className="shrink-0 px-[var(--detail-gutter)] pb-[6px]">{t(`session.${link!}`)}</Text> : null}
    </aside>
  )
}
