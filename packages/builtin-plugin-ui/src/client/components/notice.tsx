import type { VariantProps } from 'dsh-tauri/client'
import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  kind?: NoticeKind
  children?: ReactNode
}

const notice = tv({
  base: 'flex items-start gap-[8px] border border-border-l2 rounded-[8px] px-[12px] py-[10px] bg-layer-3 text-[13px] leading-[20px]',
  variants: {
    kind: {
      ok: 'border-success/35 bg-success/8',
      error: 'border-error/35 bg-error/8',
      info: 'border-business/35 bg-business/8',
    },
  },
})

export type NoticeKind = NonNullable<VariantProps<typeof notice>['kind']>

export function Notice({ kind, className, children, ...rest }: NoticeProps): ReactElement {
  return <div className={notice({ kind, className })} role="status" {...rest}>{children}</div>
}
