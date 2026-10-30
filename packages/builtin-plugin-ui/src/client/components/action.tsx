import type { VariantProps } from 'dsh-tauri/client'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'

export interface ActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant: ActionVariant
  icon?: ReactNode
  children?: ReactNode
}

const action = tv({
  base: 'inline-flex items-center justify-center border-none bg-transparent cursor-pointer disabled:cursor-default',
  variants: {
    variant: {
      search: 'shrink-0 w-[28px] h-[28px] p-0 rounded-full text-inherit hover:bg-hover',
      toolbar: 'shrink-0 w-[28px] h-[28px] rounded-sm text-[var(--dsw-alias-label-caption)] hover:not-disabled:bg-hover hover:not-disabled:text-secondary disabled:opacity-50 focus-visible:[outline:var(--dsw-focus-ring-width,2px)_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:1px]',
      model: 'box-border w-[28px] h-[28px] rounded-sm text-tertiary hover:not-disabled:bg-hover hover:not-disabled:text-primary disabled:opacity-40 focus-visible:shadow-focus-ring focus-visible:outline-none',
      round: 'relative shrink-0 w-[28px] h-[28px] p-0 rounded-sm text-secondary hover:not-disabled:bg-hover disabled:opacity-50',
      row: 'shrink-0 w-[16px] h-[16px] p-0 rounded-xs text-tertiary hover:not-disabled:text-primary disabled:opacity-50',
      help: 'shrink-0 w-[24px] h-[24px] p-0 rounded-sm text-tertiary hover:bg-[var(--dsw-alias-bg-layer-4)] hover:text-secondary focus-visible:bg-[var(--dsw-alias-bg-layer-4)] focus-visible:text-secondary aria-expanded:bg-[var(--dsw-alias-bg-layer-4)] aria-expanded:text-secondary focus-visible:[outline:var(--dsw-focus-ring-width,2px)_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:1px]',
      action: 'w-[calc(28px+var(--dsh-content-font-delta,0px))] h-[calc(28px+var(--dsh-content-font-delta,0px))] p-[6px] rounded-sm text-tertiary hover:not-disabled:bg-hover hover:not-disabled:text-secondary disabled:opacity-40',
      link: 'gap-[5px] h-[28px] px-[10px] rounded-[14px] text-tertiary [font-family:inherit] text-[12px] leading-[18px] whitespace-nowrap hover:not-disabled:bg-hover hover:not-disabled:text-secondary focus-visible:shadow-focus-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:text-secondary',
    },
  },
})

export type ActionVariant = NonNullable<VariantProps<typeof action>['variant']>

export function Action({ variant, icon, className, children, ...rest }: ActionProps): ReactElement {
  return (
    <button
      type="button"
      className={action({ variant, className })}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
