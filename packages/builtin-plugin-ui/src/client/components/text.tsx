import type { VariantProps } from 'dsh-tauri/client'
import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'

export interface TextProps extends Omit<HTMLAttributes<HTMLParagraphElement>, 'children'> {
  tone?: TextTone
  size?: TextSize
  children?: ReactNode
}

const text = tv({
  base: 'm-0',
  variants: {
    size: {
      xs: 'text-[12px] leading-[18px]',
      sm: 'text-[13px] leading-[20px]',
    },
    tone: {
      primary: 'text-primary',
      secondary: 'text-secondary',
      tertiary: 'text-tertiary',
      dimmed: 'text-dimmed',
      error: 'text-error',
      success: 'text-success',
    },
  },
  defaultVariants: { size: 'xs', tone: 'secondary' },
})

export type TextTone = NonNullable<VariantProps<typeof text>['tone']>

export type TextSize = NonNullable<VariantProps<typeof text>['size']>

export function Text({ tone, size, className, children, ...rest }: TextProps): ReactElement {
  return <p className={text({ tone, size, className })} {...rest}>{children}</p>
}
