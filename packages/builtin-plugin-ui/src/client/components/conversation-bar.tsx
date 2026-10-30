import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'

export interface ConversationBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  glyph?: ReactNode
  label?: ReactNode
  objective?: ReactNode
  error?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

export interface ConversationBarActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  iconOnly?: boolean
  children?: ReactNode
}

const conversationBar = tv({
  slots: {
    base: 'relative isolate box-border flex items-center gap-[10px] w-full mx-auto h-[36px] py-[4px] pr-[5px] pl-[12px] max-w-[calc(var(--dsh-composer-card-max-width)_-_4_*_var(--dsh-composer-dock-inset))] rounded-[12px] shadow-[var(--dsw-elevation-panel)] [--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)] before:absolute before:inset-0 before:z-[-1] before:rounded-[inherit] before:bg-[var(--dsw-specific-menu)] before:pointer-events-none before:content-[""] before:[backdrop-filter:var(--dsw-menu-backdrop-filter)]',
    glyph: 'inline-flex shrink-0 text-tertiary',
    label: 'shrink-0 text-[13px] leading-[24px] font-medium text-primary',
    objective: 'flex-1 min-w-0 overflow-hidden truncate text-[13px] leading-[20px] text-[var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-dimmed))]',
    error: 'flex-1 min-w-0 overflow-hidden truncate text-[12px] leading-[20px] text-error',
    actions: 'flex items-center shrink-0 gap-[10px] ml-auto',
  },
})

const conversationBarAction = tv({
  base: 'inline-flex items-center justify-center gap-[4px] p-0 border-0 bg-transparent rounded-[6px] text-primary [font-family:inherit] text-[13px] leading-[20px] underline decoration-transparent underline-offset-[2px] transition-[text-decoration-color] duration-[120ms] ease-[ease] cursor-pointer disabled:cursor-default hover:not-disabled:decoration-current focus-visible:shadow-focus-ring focus-visible:outline-none disabled:text-dimmed disabled:opacity-40',
  variants: {
    iconOnly: {
      true: 'w-[28px] h-[28px] rounded-full [corner-shape:round] no-underline text-tertiary hover:not-disabled:bg-hover hover:not-disabled:text-secondary disabled:text-tertiary',
      false: '',
    },
  },
})

export function ConversationBar({
  glyph,
  label,
  objective,
  error,
  actions,
  className,
  children,
  ...rest
}: ConversationBarProps): ReactElement {
  const styles = conversationBar({ className })
  return (
    <div className={styles.base()} {...rest}>
      {glyph === undefined ? null : <span className={styles.glyph()}>{glyph}</span>}
      {label === undefined ? null : <span className={styles.label()}>{label}</span>}
      {objective === undefined ? null : <span className={styles.objective()}>{objective}</span>}
      {error === undefined ? null : <span className={styles.error()} role="alert">{error}</span>}
      {children}
      {actions === undefined ? null : <div className={styles.actions()}>{actions}</div>}
    </div>
  )
}

export function ConversationBarAction({ iconOnly = false, className, children, ...rest }: ConversationBarActionProps): ReactElement {
  return (
    <button
      type="button"
      className={conversationBarAction({ iconOnly, className })}
      {...rest}
    >
      {children}
    </button>
  )
}
