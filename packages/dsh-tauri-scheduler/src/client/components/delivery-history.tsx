import type { SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { HistoryPage } from '../types'
import { Button, ChevronDown, ChevronUp, Clock, Icon, Text } from 'dsh-tauri-ui/client'
import { cn, useMount, useResizeObserver, useUnmount, useWatchImmediate } from 'dsh-tauri/client'
import { useId, useRef, useState } from 'react'
import { loadTaskHistory } from '../service/scheduler'
import { sessionLabel, sessionLinkState } from './session-link'

interface DeliveryHistoryProps {
  taskId: string
  refreshKey?: string
  timeZone?: string
  t: Translate
  sessions: SessionListState
  workspaces: WorkspaceSnapshot
  onOpenSession: (id: string) => void
}

function SavedPrompt({ prompt, t }: { prompt: string, t: Translate }): ReactElement {
  const ref = useRef<HTMLParagraphElement>(null)
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  function measure(): void {
    if (!expanded && ref.current)
      setClamped(ref.current.scrollHeight > ref.current.clientHeight)
  }
  useResizeObserver(ref, measure)
  useWatchImmediate([prompt, expanded], measure)
  return (
    <>
      <p ref={ref} id={id} className={cn('mt-[6px] mb-0 text-tertiary text-[13px] leading-[22px] whitespace-pre-wrap wrap-anywhere', !expanded && 'line-clamp-2')}>{prompt}</p>
      {clamped
        ? (
            <Button variant="link" className="mt-[2px] ml-[-6px] px-[6px] py-px gap-[2px] rounded-sm text-secondary text-[12px] leading-[20px] hover:bg-hover hover:no-underline" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
              {t(expanded ? 'history.collapse' : 'history.expand')}
              <Icon as={expanded ? ChevronUp : ChevronDown} size={14} />
            </Button>
          )
        : null}
    </>
  )
}

export function DeliveryHistory({ taskId, refreshKey, timeZone, t, sessions, workspaces, onOpenSession }: DeliveryHistoryProps): ReactElement {
  const [page, setPage] = useState<HistoryPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef({ epoch: 0, pending: false, alive: true })
  useMount(() => {
    requestRef.current.alive = true
  })
  useUnmount(() => {
    requestRef.current.alive = false
    requestRef.current.epoch++
  })

  async function load(before?: string): Promise<void> {
    if (requestRef.current.pending || !requestRef.current.alive)
      return
    requestRef.current.pending = true
    const epoch = requestRef.current.epoch
    setLoading(true)
    setError('')
    try {
      const next = await loadTaskHistory(taskId, 20, before)
      if (!requestRef.current.alive || epoch !== requestRef.current.epoch)
        return
      setPage((previous) => {
        if (!before || !previous)
          return next
        const seen = new Set(previous.records.map(record => record.id))
        return { ...next, records: [...previous.records, ...next.records.filter(record => !seen.has(record.id))] }
      })
    }
    catch (failure) {
      if (!requestRef.current.alive || epoch !== requestRef.current.epoch)
        return
      setError(failure instanceof Error ? failure.message : String(failure))
      if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'delivery_cursor_not_found') {
        requestRef.current.pending = false
        refresh()
      }
    }
    finally {
      if (requestRef.current.alive && epoch === requestRef.current.epoch) {
        requestRef.current.pending = false
        setLoading(false)
      }
    }
  }

  function refresh(): void {
    requestRef.current.epoch++
    requestRef.current.pending = false
    setPage(undefined)
    void load()
  }
  useWatchImmediate([taskId, refreshKey], refresh)

  function format(at: string): string {
    try {
      const year = new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone })
      const date = new Date(at)
      return new Intl.DateTimeFormat(t('picker.locale'), { ...(year.format(date) === year.format(Date.now()) ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(date)
    }
    catch {
      return at
    }
  }

  return (
    <section className="flex flex-1 flex-col min-w-0 min-h-0" aria-label={t('history.title')} aria-busy={loading}>
      <div className="flex-1 min-h-0 overflow-auto px-[var(--detail-gutter)] pt-[24px] pb-[28px] [scrollbar-gutter:stable] [--dsh-scrollbar-width:9px] [--dsh-scrollbar-thumb-border:2px]">
        {error
          ? (
              <div className="flex flex-col items-start gap-[8px] mb-[16px]">
                <Text tone="error" role="alert">{error}</Text>
                <Button size="sm" variant="outline" onClick={refresh}>{t('refresh')}</Button>
              </div>
            )
          : null}
        {page?.records.length === 0
          ? (
              <div className="flex flex-col items-center justify-center gap-[16px] min-h-[240px]" role="status">
                <Icon as={Clock} size={24} className="text-tertiary" />
                <Text tone="tertiary" size="sm">{t('history.empty')}</Text>
              </div>
            )
          : null}
        <ul className="m-0 p-0 list-none">
          {page?.records.map((record) => {
            const state = record.sessionId ? sessionLinkState(record.sessionId, sessions, workspaces) : 'unavailable'
            return (
              <li key={record.id} className="relative flex items-start gap-[12px] mx-[-8px] px-[8px] py-[14px] rounded-[8px] text-[14px] leading-[22px] first:pt-0 before:absolute before:left-[15.75px] before:top-0 before:h-[14px] before:w-[0.5px] before:bg-[var(--dsw-alias-border-l3)] before:content-[''] first:before:hidden after:absolute after:left-[15.75px] after:top-[42px] after:bottom-0 after:w-[0.5px] after:bg-[var(--dsw-alias-border-l3)] after:content-[''] first:after:top-[28px] last:after:hidden">
                <Icon as={Clock} size={16} className="shrink-0 mt-[6px] text-tertiary" />
                <div className="flex-1 min-w-0 py-[2px]">
                  {record.sessionId
                    ? <button type="button" className="block p-0 border-none bg-transparent text-primary [font-family:inherit] text-[14px] leading-[22px] font-medium text-left cursor-pointer hover:not-disabled:underline focus-visible:shadow-focus-ring disabled:cursor-default" disabled={state !== 'available'} title={t(`session.${state}`)} aria-label={`${t('history.open')}: ${sessionLabel(record.sessionId, sessions).text}`} onClick={() => record.sessionId && onOpenSession(record.sessionId)}><time dateTime={record.delivery === 'this-session' ? record.scheduledAt : record.scheduledFor}>{format(record.delivery === 'this-session' ? record.scheduledAt : record.scheduledFor)}</time></button>
                    : <time dateTime={record.delivery === 'this-session' ? record.scheduledAt : record.scheduledFor} className="block text-primary text-[14px] leading-[22px] font-medium">{format(record.delivery === 'this-session' ? record.scheduledAt : record.scheduledFor)}</time>}
                  {record.prompt ? <SavedPrompt prompt={record.prompt} t={t} /> : null}
                  {record.delivery === 'new-session' && record.error ? <Text size="sm" tone="error" role="status">{record.error}</Text> : null}
                </div>
              </li>
            )
          })}
        </ul>
        {loading ? <Text size="sm" tone="secondary">{t('loading')}</Text> : null}
        {page?.nextBefore ? <Button variant="outline" disabled={loading} onClick={() => void load(page.nextBefore)}>{t('history.more')}</Button> : null}
      </div>
      {page?.earlierRecordsUnavailable || page?.earlierRecordsPruned
        ? (
            <footer className="shrink-0 px-[var(--detail-gutter)] pb-[16px] text-tertiary text-[12px] leading-[20px]">
              {page.earlierRecordsUnavailable ? <Text size="sm" tone="tertiary">{t('history.unavailable')}</Text> : null}
              {page.earlierRecordsPruned ? <Text size="sm" tone="tertiary">{t('history.pruned', page.retention)}</Text> : null}
            </footer>
          )
        : null}
    </section>
  )
}
