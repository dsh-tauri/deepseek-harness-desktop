import type { VariantProps } from 'dsh-tauri/client'
import type { ReactElement, TextareaHTMLAttributes } from 'react'
import { tv } from 'dsh-tauri/client'

const textarea = tv({
  base: 'w-full box-border border border-border-l2 rounded-[8px] px-[10px] py-[7px] outline-none bg-layer-1 text-primary [font-family:var(--ds-font-family-code)] text-[13px] leading-[1.5] resize-y focus-visible:border-business focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--dsw-alias-state-business-primary)_18%,transparent)]',
  variants: {
    size: {
      tall: 'min-h-[320px]',
      short: 'min-h-[96px]',
      compact: 'min-h-[260px]',
    },
  },
  defaultVariants: { size: 'tall' },
})

export type TextareaSize = NonNullable<VariantProps<typeof textarea>['size']>

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: TextareaSize
}

export function Textarea({ size, className, ...rest }: TextareaProps): ReactElement {
  return <textarea className={textarea({ size, className })} {...rest} />
}
