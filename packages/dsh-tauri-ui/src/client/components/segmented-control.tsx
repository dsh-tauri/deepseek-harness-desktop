import type { VariantProps } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import { tv } from 'dsh-tauri/client'
import { useRef } from 'react'

export interface SegmentedControlOption {
  value: string
  label: string
  disabled?: boolean
  title?: string
}

export interface SegmentedControlProps {
  id?: string
  label?: string
  value: string
  disabled?: boolean
  options: readonly SegmentedControlOption[]
  onChange: (next: string) => void
  variant?: NonNullable<VariantProps<typeof segmentedControl>['variant']>
}

const segmentedControl = tv({
  slots: {
    base: 'box-border inline-flex items-center border-none',
    option: 'box-border inline-flex items-center justify-center border-none bg-transparent cursor-pointer [font-family:inherit] text-[13px] whitespace-nowrap focus-visible:shadow-focus-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
  },
  variants: {
    variant: {
      segmented: {
        base: 'gap-[2px] p-[2px] rounded-[10px] bg-module-platform',
        option: 'gap-[6px] min-h-[28px] px-[12px] rounded-[8px] text-secondary leading-[20px] hover:not-disabled:bg-hover hover:not-disabled:text-primary',
      },
      underline: {
        base: 'flex-1 min-w-0 gap-[36px] self-end overflow-x-auto pb-px mb-[-1px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        option: 'relative shrink-0 px-0 pt-0 pb-[9px] text-tertiary leading-[16px] font-medium after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:rounded-[2px] after:content-[\'\']',
      },
    },
    selected: { true: {}, false: {} },
  },
  compoundVariants: [
    { variant: 'segmented', selected: true, class: { option: 'bg-layer-1 text-primary font-medium shadow-[inset_0_0_0_0.5px_var(--dsw-alias-border-l3)] hover:not-disabled:bg-layer-1 hover:not-disabled:text-primary' } },
    { variant: 'underline', selected: true, class: { option: 'text-business after:bg-business' } },
  ],
  defaultVariants: { variant: 'segmented' },
})

const FORWARD_KEYS = ['ArrowRight', 'ArrowDown']
const BACKWARD_KEYS = ['ArrowLeft', 'ArrowUp']

export function stepSegment<T extends { disabled?: boolean }>(
  options: readonly T[],
  current: number,
  key: string,
): number | undefined {
  const count = options.length
  if (count === 0)
    return undefined
  if (key === 'Home' || key === 'End') {
    const index = key === 'Home' ? 0 : count - 1
    return options[index]?.disabled === true ? undefined : index
  }
  const forward = FORWARD_KEYS.includes(key)
  if (!forward && !BACKWARD_KEYS.includes(key))
    return undefined
  const step = forward ? 1 : -1
  for (let offset = 1; offset <= count; offset++) {
    const index = ((current + step * offset) % count + count) % count
    if (options[index]?.disabled !== true)
      return index
  }
  return undefined
}

export function SegmentedControl({ id, label, value, disabled, options, onChange, variant }: SegmentedControlProps): ReactElement {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])
  const styles = segmentedControl({ variant })
  const tabbed = id !== undefined
  const selected = options.findIndex(option => option.value === value)

  const move = (key: string): void => {
    if (disabled === true)
      return
    const index = stepSegment(options, selected < 0 ? 0 : selected, key)
    if (index === undefined)
      return
    const option = options[index]
    if (option === undefined)
      return
    buttonsRef.current[index]?.focus()
    if (option.value !== value)
      onChange(option.value)
  }

  const segmentId = (index: number): string | undefined => {
    if (id === undefined)
      return undefined
    return `${id}-${options[index]?.value ?? index}`
  }

  return (
    <div
      className={styles.base()}
      role={tabbed ? 'tablist' : 'group'}
      aria-label={label}
      onKeyDown={(event) => {
        move(event.key)
      }}
    >
      {options.map((option, index) => {
        const active = option.value === value
        const locked = disabled === true || option.disabled === true
        return (
          <button
            key={option.value}
            ref={(node) => { buttonsRef.current[index] = node }}
            type="button"
            id={segmentId(index)}
            role={tabbed ? 'tab' : undefined}
            className={segmentedControl({ variant, selected: active }).option()}
            aria-selected={tabbed ? active : undefined}
            aria-controls={tabbed && id !== undefined ? `${id}-${option.value}-panel` : undefined}
            aria-pressed={tabbed ? undefined : active}
            tabIndex={tabbed ? (active || (selected < 0 && index === 0) ? 0 : -1) : undefined}
            title={option.title}
            disabled={locked}
            onClick={() => {
              if (!locked && !active)
                onChange(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
