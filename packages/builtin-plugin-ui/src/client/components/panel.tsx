import type { ReactElement, ReactNode } from 'react'

export function Panel({ children }: { children: ReactNode }): ReactElement {
  return <div className="box-border flex flex-col items-center gap-8 h-full px-[clamp(24px,4vw,48px)] pt-[28px] pb-[48px] overflow-auto text-[var(--dsw-alias-label-primary)] [&>*]:w-full [&>*]:max-w-[960px]">{children}</div>
}
