import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VariantProps } from 'dsh-tauri/client'
import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { Tag as PrimitiveTag } from '@deepseek-ai/dsh-client-ui-primitives'
import { tv } from 'dsh-tauri/client'

export type { TagTone }

export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  variant?: TagVariant
  tone?: TagTone
  children?: ReactNode
}

const localVariants = {
  version: 'inline-flex items-center shrink-0 py-[1px] px-[8px] rounded-full [corner-shape:round] text-[11px] leading-[17px] font-medium whitespace-nowrap tabular-nums data-[tone=outline]:border-[0.5px] data-[tone=outline]:border-border-l4 data-[tone=outline]:text-tertiary data-[tone=neutral]:bg-module-platform data-[tone=neutral]:text-secondary',
  status: 'inline-flex items-center h-[18px] px-[7px] rounded-full [corner-shape:round] text-[10px] leading-none font-medium whitespace-nowrap data-[tone=outline]:border-[0.5px] data-[tone=outline]:border-border-l4 data-[tone=outline]:text-tertiary data-[tone=info]:bg-[color-mix(in_srgb,var(--dsw-alias-state-business-primary)_10%,transparent)] data-[tone=info]:text-business data-[tone=danger]:bg-[color-mix(in_srgb,var(--dsw-alias-state-error-primary)_10%,transparent)] data-[tone=danger]:text-error',
} as const

const localTag = tv({ variants: { variant: localVariants } })

export type TagVariant = 'default' | NonNullable<VariantProps<typeof localTag>['variant']>

export function Tag({ variant = 'default', tone = 'outline', className, children, ...rest }: TagProps): ReactElement {
  if (variant === 'default')
    return <PrimitiveTag tone={tone} className={className} {...rest}>{children}</PrimitiveTag>
  return (
    <span className={localTag({ variant, className })} data-tone={tone} {...rest}>
      {children}
    </span>
  )
}
