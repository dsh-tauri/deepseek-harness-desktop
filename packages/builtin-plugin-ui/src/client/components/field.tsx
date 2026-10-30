import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { cn } from 'dsh-tauri/client'

export interface FieldProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: ReactNode
  as?: 'label' | 'div'
  children?: ReactNode
}

export function Field({ label, as = 'label', className, children, ...rest }: FieldProps): ReactElement {
  const Tag = as
  return (
    <Tag className={cn('flex flex-col gap-[4px] text-[12px] leading-[18px] text-secondary [&>span:first-child]:text-tertiary', className)} {...rest}>
      <span>{label}</span>
      {children}
    </Tag>
  )
}
