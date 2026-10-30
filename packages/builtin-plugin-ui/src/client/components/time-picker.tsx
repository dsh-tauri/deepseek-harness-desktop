import type { ButtonHTMLAttributes, KeyboardEvent } from 'react'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { tv, useWatchImmediate } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { PickerPopover, pickerTrigger } from './picker-popover'

export interface TimePickerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  label: string
  hourLabel: string
  minuteLabel: string
  secondLabel: string
  seconds?: boolean
}

const OPTIONS = [24, 60, 60].map(count => Array.from({ length: count }, (_, index) => String(index).padStart(2, '0')))
const clock = tv({
  slots: {
    panel: 'flex-row gap-[2px] p-[3px]',
    column: 'flex flex-col w-[52px] max-h-[216px] overflow-y-auto overscroll-contain',
    option: 'flex shrink-0 items-center justify-center min-h-[32px] rounded-[10px] text-primary text-[13px] leading-[1.6] tabular-nums cursor-pointer outline-none hover:bg-hover focus-visible:[outline:2px_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:-2px] aria-selected:bg-[var(--dsw-alias-button-ghost-active-fill)] aria-selected:shadow-[inset_0_0_0_1px_var(--dsw-alias-button-ghost-active-border)]',
  },
})

function clockBase(value: string): string[] {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(value) ? `${value}:00`.slice(0, 8).split(':') : ['00', '00', '00']
}

export function TimePicker({ value, onChange, label, hourLabel, minuteLabel, secondLabel, seconds = true, disabled, className, onClick, ...rest }: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(() => ({ column: 0, index: Number(clockBase(value)[0]) }))
  const anchorRef = useRef<HTMLButtonElement>(null)
  const optionsRef = useRef(new Map<string, HTMLDivElement>())
  const picked = clockBase(value)
  const count = seconds ? 3 : 2
  const labels = [hourLabel, minuteLabel, secondLabel]
  const shown = open && !disabled
  const styles = clock()
  useWatchImmediate([shown, disabled], ([visible, blocked]) => {
    if (blocked)
      setOpen(false)
    if (!visible)
      return
    setCursor({ column: 0, index: Number(picked[0]) })
    for (let column = 0; column < count; column++)
      optionsRef.current.get(`${column}:${Number(picked[column])}`)?.scrollIntoView?.({ block: 'nearest' })
  })
  useWatchImmediate([shown, cursor], () => {
    if (!shown)
      return
    const element = optionsRef.current.get(`${cursor.column}:${cursor.index}`)
    element?.focus()
    element?.scrollIntoView?.({ block: 'nearest' })
  })

  function pick(column: number, option: string, index: number): void {
    setCursor({ column, index })
    const next = [...picked]
    next[column] = option
    onChange(next.slice(0, count).join(':'))
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLDivElement>, column: number, index: number, option: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(column, option, index)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = column + (event.key === 'ArrowRight' ? 1 : -1)
      if (next >= 0 && next < count)
        setCursor({ column: next, index: Math.min(index, OPTIONS[next].length - 1) })
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursor({ column, index: event.key === 'Home' ? 0 : OPTIONS[column].length - 1 })
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
      return
    event.preventDefault()
    setCursor({ column, index: Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), OPTIONS[column].length - 1) })
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
        <span>{value ? picked.slice(0, count).join(':') : ''}</span>
        <IconClockOutlineRegular className="shrink-0 text-tertiary" />
      </button>
      <PickerPopover open={shown} anchorRef={anchorRef} label={label} className={styles.panel()} onClose={() => setOpen(false)}>
        {OPTIONS.slice(0, count).map((options, column) => (
          <div key={column === 0 ? 'hours' : column === 1 ? 'minutes' : 'seconds'} role="listbox" aria-label={labels[column]} className={styles.column()}>
            {options.map((option, index) => (
              <div
                key={option}
                ref={(element) => {
                  const key = `${column}:${index}`
                  if (element)
                    optionsRef.current.set(key, element)
                  else
                    optionsRef.current.delete(key)
                }}
                role="option"
                aria-selected={option === picked[column]}
                tabIndex={(cursor.column === column ? cursor.index : Number(picked[column])) === index ? 0 : -1}
                className={styles.option()}
                onClick={() => pick(column, option, index)}
                onKeyDown={event => onOptionKeyDown(event, column, index, option)}
              >
                {option}
              </div>
            ))}
          </div>
        ))}
      </PickerPopover>
    </>
  )
}
