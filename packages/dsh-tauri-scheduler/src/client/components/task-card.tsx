import type { MenuEntry } from 'dsh-tauri-ui/client'
import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { TaskView } from '../types'
import { Action, Card, CirclePause, CirclePlay, EllipsisVertical, Icon, Menu, Tag, Text, Toast, TrashBin, TriangleExclamation as Warning } from 'dsh-tauri-ui/client'
import { cn } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { requestTaskDeletion } from '../service/deletion'
import { runTask, toggleTask } from '../service/scheduler'

export interface TaskCardProps {
  task: TaskView
  t: Translate
  describe: string
  nextRun?: string
  paused: boolean
  onEdit: (task: TaskView) => void
}

export function TaskCard({ task, t, describe, nextRun, paused, onEdit }: TaskCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [toast, setToast] = useState<{ text: string, seq: number } | null>(null)
  const cardRef = useRef<HTMLLIElement | null>(null)
  const inactive = task.status === 'inactive'

  async function runAction(action: () => Promise<{ ok: boolean, error?: string }>, errorKey: LocaleKey): Promise<void> {
    const result = await action()
    if (!result.ok) {
      const message = result.error ?? t(errorKey)
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
      return
    }
    setActionError('')
    setToast(null)
  }

  const items: MenuEntry[] = [
    { id: 'edit', label: t('edit'), icon: <Icon as={CirclePlay} /> },
    { id: 'run', label: t('runNow'), icon: <Icon as={CirclePlay} />, disabled: inactive },
    { id: 'toggle', label: paused ? t('resume') : t('pause'), icon: <Icon as={CirclePause} />, disabled: inactive },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('delete'), icon: <Icon as={TrashBin} />, danger: true },
  ]

  return (
    <Card
      ref={cardRef}
      variant="link"
      className={cn('box-border mx-0 flex justify-between items-center gap-[10px] w-full min-w-0 h-[60px] px-[12px] py-[10px] rounded-[10px] text-inherit [font-family:inherit] text-[13px] leading-[20px] text-left cursor-pointer overflow-hidden', (paused || inactive) && 'opacity-60')}
      onClick={(event) => {
        if (event.currentTarget.contains(event.target as Node))
          onEdit(task)
      }}
    >
      <div style={{ height: 36 }}>
        <Action
          variant="action"
          disabled={inactive}
          icon={paused ? <Icon as={CirclePlay} /> : <Icon as={CirclePause} />}
          aria-label={paused ? t('resume') : t('pause')}
          onClick={(event) => {
            event.stopPropagation()
            void runAction(() => toggleTask(task.id, paused), 'toggleFailed')
          }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[6px] min-w-0">
          <Card.Title className="min-w-0 text-[13px] leading-[18px]" title={task.name}>{task.name}</Card.Title>
          {task.delivery === 'this-session' ? <Tag variant="status" className="box-border shrink-0">{t('task.session')}</Tag> : null}
        </div>
        <div className="flex items-center gap-[10px] min-w-0">
          <Card.Description className="flex-1 min-w-0 text-[12px] line-clamp-none truncate">
            {describe}
            {' · '}
            {nextRun !== undefined
              ? (
                  <strong>
                    {t('nextRun')}
                    {' '}
                    {nextRun}
                  </strong>
                )
              : <strong>{t(inactive ? 'task.inactive' : 'paused')}</strong>}
          </Card.Description>
          {task.waiting === true ? <Tag variant="status" tone="info">{t('waiting')}</Tag> : null}
        </div>
      </div>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'edit')
            onEdit(task)
          else if (id === 'run' && !inactive)
            void runAction(() => runTask(task.id), 'runFailed')
          else if (id === 'toggle' && !inactive)
            void runAction(() => toggleTask(task.id, paused), 'toggleFailed')
          else if (id === 'delete')
            requestTaskDeletion(task)
        }}
        items={items}
        portal
        align="end"
        anchor={(
          <Action
            variant="action"
            icon={<Icon as={EllipsisVertical} size={12} />}
            aria-label={task.name}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen(openState => !openState)
            }}
          />
        )}
      />
      {actionError ? <Text tone="error" role="alert">{actionError}</Text> : null}
      {toast !== null ? <Toast key={toast.seq} text={toast.text} icon={<Icon as={Warning} />} anchor={cardRef.current} onDone={() => setToast(null)} /> : null}
    </Card>
  )
}
