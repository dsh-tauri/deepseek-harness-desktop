import type { ButtonHTMLAttributes, KeyboardEvent } from 'react'
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { tv, useWatchImmediate } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { Icon } from './icon'
import { Calendar } from './icons'
import { PickerPopover, pickerTrigger } from './picker-popover'

export interface DatePickerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  label: string
  locale: string
  previousMonthLabel: string
  nextMonthLabel: string
  weekdayLabels?: readonly [string, string, string, string, string, string, string]
}

interface MonthView {
  year: number
  month: number
  day: number
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const calendar = tv({
  slots: {
    panel: 'flex-col gap-[4px] w-[232px] p-[8px]',
    head: 'flex items-center justify-between gap-[4px]',
    title: 'flex-auto text-primary text-[13px] leading-[1.6] text-center',
    nav: 'inline-flex shrink-0 items-center justify-center w-[26px] h-[26px] p-0 border-0 rounded-[8px] bg-transparent text-secondary cursor-pointer hover:not-disabled:bg-hover disabled:cursor-default disabled:text-tertiary focus-visible:[outline:2px_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:-2px]',
    grid: 'flex flex-col gap-[2px]',
    week: 'grid grid-cols-7 gap-[2px]',
    weekday: 'flex items-center justify-center h-[22px] text-tertiary text-[11px] leading-[1.6]',
    day: 'flex items-center justify-center h-[28px] rounded-[8px] text-primary text-[13px] leading-[1.6] tabular-nums cursor-pointer outline-none hover:bg-hover focus-visible:[outline:2px_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:-2px] aria-[current=date]:shadow-[inset_0_0_0_0.5px_var(--dsw-alias-border-l3)] aria-selected:bg-[var(--dsw-alias-button-ghost-active-fill)] aria-selected:shadow-[inset_0_0_0_1px_var(--dsw-alias-button-ghost-active-border)]',
    blank: 'h-[28px]',
  },
})

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  return date
}

function viewOf(value: string): MonthView {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(Number.NaN)
  if (Number.isFinite(date.getTime()) && date.getUTCFullYear() > 0 && date.toISOString().slice(0, 10) === value)
    return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() }
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
}

function daysIn(view: MonthView): number {
  return utcDate(view.year, view.month + 1, 0).getUTCDate()
}

function isoOf(view: MonthView, day: number): string {
  return `${String(view.year).padStart(4, '0')}-${String(view.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function DatePicker({ value, onChange, label, locale, previousMonthLabel, nextMonthLabel, weekdayLabels, disabled, className, onClick, ...rest }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => viewOf(value))
  const anchorRef = useRef<HTMLButtonElement>(null)
  const daysRef = useRef(new Map<number, HTMLDivElement>())
  const shown = open && !disabled
  const styles = calendar()
  useWatchImmediate([shown, disabled], ([visible, blocked]) => {
    if (blocked)
      setOpen(false)
    if (visible)
      setView(viewOf(value))
  })
  useWatchImmediate([shown, view], () => {
    if (shown)
      daysRef.current.get(view.day)?.focus()
  })
  const total = daysIn(view)
  const offset = (utcDate(view.year, view.month, 1).getUTCDay() + 6) % 7
  const weekCount = Math.ceil((offset + total) / 7)
  const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(view.year, view.month, 1))
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' })
  const weekdays = weekdayLabels ?? Array.from({ length: 7 }, (_, index) => weekdayFormat.format(utcDate(2024, 0, index + 1)))
  const today = viewOf('')
  const todayIso = isoOf(today, today.day)

  function shiftMonth(step: number): void {
    setView((current) => {
      const months = Math.min(Math.max(current.year * 12 + current.month + step, 12), 9999 * 12 + 11)
      const moved = { ...current, year: Math.floor(months / 12), month: months % 12 }
      return { ...moved, day: Math.min(current.day, daysIn(moved)) }
    })
  }

  function pick(day: number): void {
    setView(current => ({ ...current, day }))
    onChange(isoOf(view, day))
  }

  function onCellKeyDown(event: KeyboardEvent<HTMLDivElement>, day: number): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(day)
      return
    }
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (step === undefined)
      return
    event.preventDefault()
    setView(current => ({ ...current, day: Math.min(Math.max(day + step, 1), total) }))
  }

  return (
    <>
      <button
        {...rest}
        ref={anchorRef}
        type="button"
        className={pickerTrigger({ className })}
        disabled={disabled}
        aria-label={rest['aria-label'] ?? label}
        aria-haspopup="dialog"
        aria-expanded={shown}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented)
            setOpen(state => !state)
        }}
      >
        <span>{value.replaceAll('-', '/')}</span>
        <Icon as={Calendar} className="shrink-0 text-tertiary" />
      </button>
      <PickerPopover open={shown} anchorRef={anchorRef} label={label} className={styles.panel()} onClose={() => setOpen(false)}>
        <div className={styles.head()}>
          <button type="button" className={styles.nav()} aria-label={previousMonthLabel} disabled={view.year === 1 && view.month === 0} onClick={() => shiftMonth(-1)}>
            <IconChevronLeftOutlineRegular />
          </button>
          <span className={styles.title()} aria-live="polite">{monthTitle}</span>
          <button type="button" className={styles.nav()} aria-label={nextMonthLabel} disabled={view.year === 9999 && view.month === 11} onClick={() => shiftMonth(1)}>
            <IconChevronRightOutlineRegular />
          </button>
        </div>
        <div className={styles.grid()} role="grid" aria-label={monthTitle}>
          <div role="row" className={styles.week()}>
            {weekdays.map((weekday, index) => <div key={WEEKDAYS[index]} role="columnheader" className={styles.weekday()}>{weekday}</div>)}
          </div>
          {Array.from({ length: weekCount }, (_, week) => (
            <div key={week} role="row" className={styles.week()}>
              {Array.from({ length: 7 }, (_, column) => week * 7 + column - offset + 1).map(day => (
                day < 1 || day > total
                  ? <div key={day} role="gridcell" aria-hidden="true" className={styles.blank()} />
                  : (
                      <div
                        key={day}
                        ref={(element) => {
                          if (element)
                            daysRef.current.set(day, element)
                          else
                            daysRef.current.delete(day)
                        }}
                        role="gridcell"
                        aria-selected={isoOf(view, day) === value}
                        aria-current={isoOf(view, day) === todayIso ? 'date' : undefined}
                        tabIndex={day === view.day ? 0 : -1}
                        className={styles.day()}
                        onClick={() => pick(day)}
                        onKeyDown={event => onCellKeyDown(event, day)}
                      >
                        {day}
                      </div>
                    )
              ))}
            </div>
          ))}
        </div>
      </PickerPopover>
    </>
  )
}
