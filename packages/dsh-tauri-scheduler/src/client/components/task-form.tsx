import type { SelectOption } from 'dsh-tauri-ui/client'
import type { SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { ReactElement, ReactNode } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { ScheduleForm, ScheduleKind, SchedulerOptions, TaskFormState, TaskView, Weekday } from '../types'
import { Button, Checkbox, ChevronDown, DatePicker, Icon, Menu, Select, Text, TimePicker } from 'dsh-tauri-ui/client'
import { cloneDeep, isEmpty, isEqual, map, useMount, useTimeoutPoll, useUnmount, useWatchImmediate } from 'dsh-tauri/client'
import { useId, useMemo, useRef, useState } from 'react'
import { SCHEDULE_KINDS } from '../../shared/constants'
import { createTask, updateTask } from '../service/scheduler'
import { ModelPicker } from './model-picker'
import { formatRelative } from './schedule.utils'
import { sessionLabel, sessionLinkState } from './session-link'
import { absoluteDateTime, defaultScheduleFor, emptyTaskForm, localDateTime, taskFormInput, taskToForm } from './task-form.utils'

interface TaskFormProps {
  t: Translate
  options: SchedulerOptions
  sessions: SessionListState
  workspaces: WorkspaceSnapshot
  onClose: () => void
  onSaved: (task: TaskView) => void
  task?: TaskView
  currentTask?: TaskView
  initial?: TaskFormState
  defaultSessionId: string
  disabled?: boolean
  id?: string
  view?: 'rule' | 'records'
  feedback?: ReactNode
  recommendations?: ReactNode
  history?: ReactNode
}

const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const PERMISSION_KEYS: Record<string, LocaleKey> = {
  'read-only': 'permissionReadOnly',
  'workspace-write': 'permissionWrite',
  'danger-full-access': 'permissionFullAccess',
}
const WEEKDAY_KEYS: Record<Weekday, LocaleKey> = {
  MO: 'dayMon',
  TU: 'dayTue',
  WE: 'dayWed',
  TH: 'dayThu',
  FR: 'dayFri',
  SA: 'daySat',
  SU: 'daySun',
}
const SCHEDULE_KEYS: Record<ScheduleKind, LocaleKey> = {
  once: 'scheduleOnce',
  hourly: 'scheduleHourly',
  daily: 'scheduleDaily',
  interval: 'scheduleInterval',
  workdays: 'scheduleWorkdays',
  weekly: 'scheduleWeekly',
  monthly: 'scheduleMonthly',
  custom: 'scheduleCustom',
}
const MINUTE_OPTIONS: SelectOption[] = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute), label: `: ${String(minute).padStart(2, '0')}` }))
const VALUE_CLASS = 'flex-[0_1_auto] min-w-0 max-w-full min-h-[32px] h-auto gap-[6px] px-[8px] rounded-[18px] bg-transparent text-primary [font-family:inherit] text-[14px] font-normal leading-[1.6] hover:not-disabled:bg-hover focus-visible:shadow-focus-ring'
const INPUT_CLASS = 'flex-[0_1_58%] min-w-0 px-[8px] py-[5px] border-none rounded-[18px] bg-transparent text-primary [font-family:inherit] text-[14px] leading-[1.6] text-right outline-none hover:not-disabled:bg-hover focus-visible:shadow-focus-ring'

function RuleRow({ label, children }: { label: ReactNode, children: ReactNode }): ReactElement {
  return (
    <div className="box-border flex w-full items-center justify-between gap-[12px] min-h-[48px] border-b-[0.5px] border-border-l3 last:border-b-0">
      <span className="shrink-0 text-primary text-[14px] leading-[1.6]">{label}</span>
      {children}
    </div>
  )
}

const RECENT_KEY = 'dsh.schedule.recent-time-zones.v1'

function zoneLabel(zone: string, locale: string, system: string, systemLabel: string, at: number): { label: string, offset: number } {
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset)
    const minutes = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1) : 0
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value
    const stamp = offset === 'GMT' ? 'UTC+00:00' : offset.replace('GMT', 'UTC')
    return { label: `${name && !name.startsWith('GMT') ? `${stamp} · ${name}` : stamp}${zone === system ? systemLabel : ''}`, offset: minutes }
  }
  catch {
    return { label: zone, offset: Number.POSITIVE_INFINITY }
  }
}

function recentZones(system: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? 'null')
    if (Array.isArray(parsed)) {
      const zones = [...new Set(parsed.filter((zone): zone is string => typeof zone === 'string' && !!zone))].slice(0, 5)
      if (zones.length)
        return zones
    }
  }
  catch {}
  return [...new Set([system, 'UTC'])]
}

function TimeZonePicker({ value, onChange, t, disabled }: { value: string, onChange: (value: string) => void, t: Translate, disabled?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const system = new Intl.DateTimeFormat().resolvedOptions().timeZone
  const [recent, setRecent] = useState(() => recentZones(system))
  const [at, setAt] = useState(() => Date.now())
  const locale = t('picker.locale')
  useWatchImmediate(disabled, () => {
    if (disabled)
      setOpen(false)
  })
  const choices = useMemo(() => {
    if (!open)
      return []
    let inventory: string[] = []
    try {
      inventory = Intl.supportedValuesOf('timeZone')
    }
    catch {}
    const zones = [...new Set([system, 'UTC', value, ...inventory])].map(id => ({ id, ...zoneLabel(id, locale, system, t('picker.system'), at) }))
    zones.sort((a, b) => a.id === system ? -1 : b.id === system ? 1 : a.offset - b.offset || a.id.localeCompare(b.id))
    const grouped = new Map<string, { id: string, label: string, zones: string[] }>()
    for (const zone of zones) {
      const existing = grouped.get(zone.label)
      if (existing) {
        existing.zones.push(zone.id)
        if (zone.id === value)
          existing.id = value
      }
      else {
        grouped.set(zone.label, { id: zone.id, label: zone.label, zones: [zone.id] })
      }
    }
    return [...grouped.values()]
  }, [open, value, system, locale, t, at])
  const normalized = query.trim().toLocaleLowerCase(locale)
  const matches = choices.filter(item => `${item.label} ${item.zones.join(' ')}`.toLocaleLowerCase(locale).includes(normalized)).map((item) => {
    const ids = item.zones.filter(id => id.toLocaleLowerCase(locale).includes(normalized))
    const exact = ids.find(id => id.toLocaleLowerCase(locale) === normalized)
    return { ...item, id: exact ?? (ids.includes(item.id) ? item.id : ids[0]) ?? item.id }
  })
  const recentItems = normalized
    ? []
    : recent.flatMap((id) => {
        const item = choices.find(choice => choice.zones.includes(id))
        return item ? [{ ...item, id }] : []
      }).filter((item, index, items) => items.findIndex(other => other.label === item.label) === index)
  const recentLabels = new Set(recentItems.map(item => item.label))
  const remaining = matches.filter(item => !recentLabels.has(item.label))
  function choose(zone: string): void {
    if (disabled)
      return
    const next = [zone, ...recent.filter(item => item !== zone)].slice(0, 5)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    }
    catch {}
    setOpen(false)
    setQuery('')
    onChange(zone)
  }
  return (
    <Menu
      open={open && !disabled}
      onClose={() => {
        setOpen(false)
        setQuery('')
      }}
      portal
      align="end"
      listClassName="w-[360px] max-w-[calc(100vw-32px)] max-h-[min(420px,calc(100dvh-48px))] rounded-[16px] p-[3px]"
      anchor={(
        <button
          type="button"
          disabled={disabled}
          aria-label={t('timeZone')}
          title={value}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex min-w-0 items-center justify-end gap-[6px] min-h-[32px] px-[8px] border-none rounded-[18px] bg-transparent text-primary [font-family:inherit] text-[14px] leading-[1.6] text-right cursor-pointer hover:not-disabled:bg-hover focus-visible:shadow-focus-ring disabled:text-tertiary"
          onClick={() => {
            setAt(Date.now())
            setQuery('')
            setOpen(value => !value)
          }}
        >
          <span className="truncate">{zoneLabel(value, locale, system, t('picker.system'), at).label}</span>
          <Icon as={ChevronDown} size={14} className="shrink-0 text-tertiary" />
        </button>
      )}
    >
      <div className="sticky top-0 z-[1] px-[4px] pb-[4px] bg-[var(--dsw-specific-menu)]">
        <input type="search" aria-label={t('picker.zoneSearch')} placeholder={t('picker.zoneSearch')} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} className="box-border w-full px-[8px] py-[6px] border-[0.5px] border-border-l2 rounded-[7px] outline-none bg-[var(--dsw-alias-bg-base)] text-primary [font-family:inherit] text-[13px] leading-[20px] focus:border-business" />
      </div>
      {recentItems.map(item => <button key={`recent-${item.id}`} type="button" disabled={disabled} role="menuitem" title={item.id} className="block w-full text-left px-[12px] py-[8px] rounded-[10px] border-none bg-transparent text-primary [font-family:inherit] text-[13px] leading-[20px] cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => choose(item.id)}>{item.label}</button>)}
      {recentItems.length && remaining.length ? <hr role="separator" className="h-[0.5px] mx-[4px] my-[6px] border-none bg-[var(--dsw-alias-border-l3)]" /> : null}
      {remaining.map(item => <button key={item.id} type="button" disabled={disabled} role="menuitem" title={item.id} className="block w-full text-left px-[12px] py-[8px] rounded-[10px] border-none bg-transparent text-primary [font-family:inherit] text-[13px] leading-[20px] cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => choose(item.id)}>{item.label}</button>)}
    </Menu>
  )
}

export function TaskForm({ t, options, sessions, workspaces, onClose, onSaved, task, currentTask, initial, defaultSessionId, disabled, id, view = 'rule', feedback, recommendations, history }: TaskFormProps): ReactElement {
  const fallbackId = useId()
  const panelId = id ?? fallbackId
  const [expected] = useState(() => task ? cloneDeep(task) : undefined)
  const [baseline] = useState(() => task ? taskToForm(task) : cloneDeep(initial ?? emptyTaskForm(options, defaultSessionId)))
  const [form, setForm] = useState<TaskFormState>(() => cloneDeep(baseline))
  const [onceWall, setOnceWall] = useState(() => baseline.schedule.kind === 'once' ? localDateTime(baseline.schedule.at, baseline.schedule.timeZone) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const pendingRef = useRef(false)
  const aliveRef = useRef(true)
  const clock = useTimeoutPoll(() => setNow(Date.now()), 1000, { immediate: false })
  useWatchImmediate(view, () => view === 'rule' ? clock.resume() : clock.pause())
  useMount(() => {
    aliveRef.current = true
  })
  useUnmount(() => {
    aliveRef.current = false
  })
  const link = sessionLinkState(form.sessionId, sessions, workspaces)
  const dirty = !task || !isEqual(form, baseline)
  const locked = !!disabled || saving
  const blocked = locked || (form.delivery === 'this-session' && (!form.sessionId || link !== 'available'))
  const zone = form.schedule.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone

  function setSchedule(patch: Partial<ScheduleForm>): void {
    if (locked)
      return
    setForm(state => ({ ...state, schedule: { ...state.schedule, ...patch } as ScheduleForm }))
  }

  function editOnce(wall: string): void {
    if (locked || wall === onceWall)
      return
    setOnceWall(wall)
    setSchedule({ at: absoluteDateTime(wall, zone) })
  }

  function chooseKind(kind: ScheduleKind): void {
    if (locked || kind === form.schedule.kind)
      return
    const schedule = defaultScheduleFor(kind, zone)
    setOnceWall(schedule.kind === 'once' ? localDateTime(schedule.at, zone) : '')
    setForm(state => ({ ...state, schedule }))
  }

  function cancelDraft(): void {
    if (!task) {
      onClose()
      return
    }
    setForm(cloneDeep(baseline))
    setOnceWall(baseline.schedule.kind === 'once' ? localDateTime(baseline.schedule.at, baseline.schedule.timeZone) : '')
    setError('')
  }

  async function onSave(): Promise<void> {
    if (pendingRef.current || blocked)
      return
    pendingRef.current = true
    setSaving(true)
    setError('')
    const input = taskFormInput(form, !!expected)
    const result = expected ? await updateTask(expected.id, input, expected) : await createTask(input)
    pendingRef.current = false
    if (!aliveRef.current)
      return
    setSaving(false)
    if (!result.ok || !result.task) {
      setError(result.error ?? t('createFailed'))
      return
    }
    onSaved(result.task)
  }

  const workspaceOptions: SelectOption[] = [{ value: '', label: t('workspaceDefault') }, ...options.workspaces.map(ws => ({ value: ws.id, label: ws.title || ws.path }))]
  if (form.workspaceId && !workspaceOptions.some(item => item.value === form.workspaceId))
    workspaceOptions.push({ value: form.workspaceId, label: form.workspaceId })
  const permissionOptions: SelectOption[] = isEmpty(options.permissions)
    ? Object.entries(PERMISSION_KEYS).map(([value, key]) => ({ value, label: t(key) }))
    : map(options.permissions, option => ({ value: option.value, label: PERMISSION_KEYS[option.value] ? t(PERMISSION_KEYS[option.value]) : option.name }))
  if (form.permission && !permissionOptions.some(option => option.value === form.permission))
    permissionOptions.unshift({ value: form.permission, label: form.permission })
  const sessionOptions: SelectOption[] = [{ value: '', label: t('session.select') }, ...sessions.ids.map(value => ({ value, label: sessionLabel(value, sessions).text }))]
  if (form.sessionId && !sessionOptions.some(item => item.value === form.sessionId))
    sessionOptions.push({ value: form.sessionId, label: sessionLabel(form.sessionId, sessions).text })
  const modelKey = form.provider && form.model ? `${form.provider}::${form.model}` : 'default'
  const current = currentTask ?? task
  let nextRun = current?.nextRunAt
  try {
    if (nextRun)
      nextRun = new Intl.DateTimeFormat(t('picker.locale'), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(nextRun))
  }
  catch {
    nextRun = current?.nextRunAt
  }

  return (
    <form
      className="flex flex-1 flex-col min-w-0 min-h-0 [--detail-gutter:24px] max-[1100px]:[--detail-gutter:20px] max-[400px]:[--detail-gutter:16px]"
      onSubmit={(event) => {
        event.preventDefault()
        void onSave()
      }}
    >
      <div hidden={view !== 'rule'} role="tabpanel" id={`${panelId}-rule-panel`} aria-labelledby={id ? `${id}-rule` : undefined} className="flex-1 min-h-0 overflow-auto px-[var(--detail-gutter)] pt-[24px] pb-[28px] [scrollbar-gutter:stable] [--dsh-scrollbar-width:9px] [--dsh-scrollbar-thumb-border:2px] max-[760px]:pt-[20px]">
        {feedback}
        <fieldset disabled={disabled || saving} className="border-none p-0 m-0 min-w-0">
          <header className="flex items-start gap-[10px] mb-[4px]">
            {current?.status === 'inactive'
              ? <h2 className="flex-1 min-w-0 m-0 py-[2px] text-[20px] leading-[28px] font-medium wrap-anywhere">{form.name}</h2>
              : <input className="flex-1 w-full min-w-0 min-h-[32px] p-0 border-none outline-none bg-transparent text-primary [font-family:inherit] text-[20px] leading-[28px] font-medium hover:shadow-[0_1px_var(--dsw-alias-border-l3)] focus:shadow-[0_1px_var(--dsw-alias-state-business-primary)]" type="text" aria-label={t('taskName')} required maxLength={120} value={form.name} placeholder={t('taskNamePlaceholder')} onChange={event => setForm(state => ({ ...state, name: event.target.value }))} />}
          </header>
          <div className="min-h-[20px] mb-[20px] text-tertiary text-[13px] leading-[20px] wrap-anywhere">
            {task
              ? current?.status === 'inactive'
                ? t('task.inactive')
                : !current?.enabled
                    ? t('paused')
                    : nextRun
                      ? (
                          <>
                            {t('nextRun')}
                            {' '}
                            <time dateTime={current?.nextRunAt}>{nextRun}</time>
                            {' '}
                            (
                            {formatRelative(current?.nextRunAt, now, t)}
                            )
                          </>
                        )
                      : null
              : null}
          </div>
          {current?.status === 'inactive'
            ? <p className="m-0 text-[14px] leading-[24px] whitespace-pre-wrap wrap-anywhere">{form.prompt}</p>
            : <textarea className="box-border block w-full max-w-full min-h-[112px] max-h-[160px] [field-sizing:content] m-0 p-[12px] border-[0.5px] border-border-l3 rounded-[16px] outline-none bg-[var(--dsw-alias-bg-base)] text-primary [font-family:inherit] text-[14px] leading-[24px] resize-none transition-colors hover:border-border-l2 focus:border-business [--dsh-scrollbar-width:9px] [--dsh-scrollbar-thumb-border:2px] [--dsh-scrollbar-track-margin:12px]" aria-label={t('schedulePrompt')} required maxLength={64000} value={form.prompt} placeholder={t('schedulePromptPlaceholder')} onChange={event => setForm(state => ({ ...state, prompt: event.target.value }))} />}
          <section className="mt-[28px]" aria-label={t('detail.runtime')}>
            <h3 className="mt-0 mr-0 mb-[8px] ml-[10px] text-tertiary text-[13px] leading-[20px] font-normal">{t('detail.runtime')}</h3>
            <div className="flex flex-col px-[12px] border-[0.5px] border-border-l3 rounded-[16px]">
              <RuleRow label={t('detail.repeat')}>
                <Select disabled={locked} label={t('schedule')} variant="seat" className={VALUE_CLASS} value={form.schedule.kind} options={SCHEDULE_KINDS.map(kind => ({ value: kind, label: t(SCHEDULE_KEYS[kind]) }))} onChange={value => chooseKind(value as ScheduleKind)} />
              </RuleRow>
              {form.schedule.kind === 'once'
                ? (
                    <>
                      <RuleRow label={t('picker.date')}><DatePicker disabled={locked} value={onceWall.slice(0, 10)} label={t('picker.date')} locale={t('picker.locale')} previousMonthLabel={t('picker.prevMonth')} nextMonthLabel={t('picker.nextMonth')} onChange={date => editOnce(`${date}T${onceWall.slice(11) || '00:00:00'}`)} /></RuleRow>
                      <RuleRow label={t('scheduleTime')}><TimePicker disabled={locked} value={onceWall.slice(11)} label={t('scheduleTime')} hourLabel={t('picker.hour')} minuteLabel={t('picker.minute')} secondLabel={t('picker.second')} onChange={time => editOnce(`${onceWall.slice(0, 10)}T${time}`)} /></RuleRow>
                    </>
                  )
                : form.schedule.kind === 'hourly'
                  ? <RuleRow label={t('picker.minute')}><Select disabled={locked} variant="seat" className={VALUE_CLASS} label={t('scheduleHourly')} value={String(form.schedule.minute)} options={MINUTE_OPTIONS} onChange={value => setSchedule({ minute: Number(value) })} /></RuleRow>
                  : form.schedule.kind === 'interval'
                    ? <RuleRow label={t('scheduleEveryMinutes')}><input className={INPUT_CLASS} type="number" min={Number.MIN_VALUE} step="any" max={525600} required value={form.schedule.everyMinutes} aria-label={t('scheduleEveryMinutes')} onChange={event => setSchedule({ everyMinutes: Number(event.target.value) })} /></RuleRow>
                    : (
                        <>
                          {form.schedule.kind === 'monthly' ? <RuleRow label={t('scheduleMonthDay')}><input className={INPUT_CLASS} type="number" min={1} max={31} required value={form.schedule.day} aria-label={t('scheduleMonthDay')} onChange={event => setSchedule({ day: Number(event.target.value) })} /></RuleRow> : null}
                          {form.schedule.kind === 'custom' ? <RuleRow label={t('scheduleEveryDays')}><input className={INPUT_CLASS} type="number" min={1} max={366} required value={form.schedule.everyDays} aria-label={t('scheduleEveryDays')} onChange={event => setSchedule({ everyDays: Number(event.target.value) })} /></RuleRow> : null}
                          <RuleRow label={t('scheduleTime')}><TimePicker disabled={locked} seconds={false} value={form.schedule.time} label={t('scheduleTime')} hourLabel={t('picker.hour')} minuteLabel={t('picker.minute')} secondLabel={t('picker.second')} onChange={time => setSchedule({ time })} /></RuleRow>
                          {form.schedule.kind === 'weekly' ? <RuleRow label={t('scheduleWeekdays')}><div className="flex flex-wrap justify-end gap-[4px] py-[6px]" role="group" aria-label={t('scheduleWeekdays')}>{WEEKDAYS.map(day => <Checkbox key={day} size="xs" checked={form.schedule.kind === 'weekly' && form.schedule.weekdays.includes(day)} onChange={(checked) => { setForm(state => state.schedule.kind !== 'weekly' ? state : { ...state, schedule: { ...state.schedule, weekdays: checked ? [...state.schedule.weekdays, day] : state.schedule.weekdays.filter(value => value !== day) } }) }}>{t(WEEKDAY_KEYS[day])}</Checkbox>)}</div></RuleRow> : null}
                        </>
                      )}
              <RuleRow label={t('timeZone')}>
                <TimeZonePicker
                  value={zone}
                  disabled={locked}
                  t={t}
                  onChange={(timeZone) => {
                    if (locked || timeZone === zone)
                      return
                    if (form.schedule.kind === 'once')
                      setSchedule({ timeZone, at: absoluteDateTime(onceWall, timeZone) })
                    else
                      setSchedule({ timeZone })
                  }}
                />
              </RuleRow>
            </div>
            {form.schedule.kind === 'once' ? <Text size="sm" tone="tertiary" className="mt-[8px] ml-[10px]">{t('detail.onceHint')}</Text> : null}
          </section>
          <details className="mt-[28px]" open={task ? undefined : true}>
            <summary className="mb-[8px] ml-[10px] text-tertiary text-[13px] leading-[20px] cursor-pointer">{t('detail.options')}</summary>
            <div className="flex flex-col px-[12px] border-[0.5px] border-border-l3 rounded-[16px]">
              <RuleRow label={t('delivery')}><Select disabled={locked} label={t('delivery')} variant="seat" className={VALUE_CLASS} value={form.delivery} options={[{ value: 'this-session', label: t('delivery.this-session') }, { value: 'new-session', label: t('delivery.new-session') }]} onChange={delivery => setForm(state => ({ ...state, delivery: delivery === 'this-session' ? delivery : 'new-session', sessionId: state.sessionId || defaultSessionId }))} /></RuleRow>
              {form.delivery === 'this-session'
                ? <RuleRow label={t('session.link')}><Select disabled={locked} label={t('session.link')} variant="seat" className={VALUE_CLASS} value={form.sessionId} options={sessionOptions} onChange={sessionId => setForm(state => ({ ...state, sessionId }))} /></RuleRow>
                : (
                    <>
                      <RuleRow label={t('workspace')}><Select disabled={locked} label={t('workspace')} variant="seat" className={VALUE_CLASS} value={form.workspaceId} options={workspaceOptions} onChange={workspaceId => setForm(state => ({ ...state, workspaceId }))} /></RuleRow>
                      <RuleRow label={t('permission')}><Select disabled={locked} label={t('permission')} variant="seat" className={VALUE_CLASS} value={form.permission} options={permissionOptions} onChange={permission => setForm(state => ({ ...state, permission }))} /></RuleRow>
                      <RuleRow label={t('menu.model')}>
                        <ModelPicker
                          disabled={locked}
                          t={t}
                          models={options.models}
                          failures={options.failures}
                          modelKey={modelKey}
                          reasoningEffort={form.reasoningEffort || 'none'}
                          onSelection={(nextKey, effort) => {
                            if (locked)
                              return
                            const sep = nextKey.indexOf('::')
                            setForm(state => ({ ...state, provider: sep >= 0 ? nextKey.slice(0, sep) : '', model: sep >= 0 ? nextKey.slice(sep + 2) : '', reasoningEffort: effort === 'none' ? '' : effort }))
                          }}
                        />
                      </RuleRow>
                    </>
                  )}
              <RuleRow label={t('resume')}><Checkbox checked={form.enabled} aria-label={t('resume')} onChange={enabled => setForm(state => ({ ...state, enabled }))} /></RuleRow>
            </div>
          </details>
          {form.delivery === 'this-session' ? <Text size="sm" tone={link === 'available' ? 'tertiary' : 'error'} role={link === 'available' ? undefined : 'alert'} className="mt-[8px] ml-[10px]">{link === 'available' ? t('delivery.inherited') : t(`session.${link}`)}</Text> : <Text size="sm" tone="tertiary" className="mt-[8px] ml-[10px]">{t('dialogHint')}</Text>}
        </fieldset>
        {recommendations}
      </div>
      <div hidden={view !== 'records'} role="tabpanel" id={`${panelId}-records-panel`} aria-labelledby={id ? `${id}-records` : undefined} className={view === 'records' ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}>
        {view === 'records'
          ? (
              <>
                <div className="px-[var(--detail-gutter)]">{feedback}</div>
                {history}
              </>
            )
          : null}
      </div>
      {error
        ? (
            <Text tone="error" role="alert" className="shrink-0 px-[var(--detail-gutter)] pt-[12px]">
              {error}
              <br />
              {t('task.conflictHint')}
            </Text>
          )
        : null}
      {dirty && !disabled
        ? (
            <footer className="flex shrink-0 items-center justify-end gap-[8px] px-[var(--detail-gutter)] py-[20px] border-t-[0.5px] border-border-l4 bg-[var(--dsw-alias-bg-base)] [&>button]:h-[32px] [&>button]:text-[13px] [&>button:last-child]:mr-[-8px]">
              <span className="mr-auto text-tertiary text-[12px] max-[760px]:hidden">{t('detail.unsaved')}</span>
              <Button disabled={saving} onClick={cancelDraft}>{t('cancel')}</Button>
              <Button variant="primary" type="submit" disabled={blocked}>{saving ? t('loading') : t('save')}</Button>
            </footer>
          )
        : null}
    </form>
  )
}
