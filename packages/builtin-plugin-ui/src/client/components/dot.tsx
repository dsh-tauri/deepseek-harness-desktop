import type { VariantProps } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import { tv } from 'dsh-tauri/client'

const dot = tv({
  base: 'relative inline-block shrink-0 after:absolute after:inset-[20%] after:rounded-full after:bg-current after:content-[""] after:[corner-shape:round]',
  variants: {
    state: {
      done: 'text-success',
      warning: 'text-warn',
      error: 'text-error',
      idle: 'text-idle',
    },
  },
})

export type DotState = NonNullable<VariantProps<typeof dot>['state']>

export interface DotProps {
  state?: DotState
  size?: number
  className?: string
}

export function Dot({ state, size = 10, className }: DotProps): ReactElement {
  return (
    <span
      aria-hidden
      className={dot({ state, className })}
      data-state={state}
      style={{ width: size, height: size }}
    />
  )
}
