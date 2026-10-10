// 引用源 @deepseek-ai/dsh-client-ui-primitives · packages/client/ui-primitives/src/Checkbox.tsx · 版本 0.1.7-rc.2（≥0.1.7-alpha.1）· hash default=_checkbox_1wz3s_1
import type { VariantProps } from 'dsh-tauri/client'
import type { ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'

export interface CheckboxProps {
  'checked': boolean
  'disabled'?: boolean
  'onChange': (next: boolean) => void
  'children'?: ReactNode
  'aria-label'?: string
  'title'?: string
  'size'?: NonNullable<VariantProps<typeof checkbox>['size']>
}

const checkbox = tv({
  slots: {
    base: 'inline-flex items-center gap-[6px] text-primary cursor-pointer [font-family:inherit] has-[>input:disabled]:cursor-not-allowed has-[>input:disabled]:opacity-50',
    input: 'box-border shrink-0 m-0 cursor-[inherit] accent-[var(--dsw-alias-button-primary-fill)] focus-visible:[outline:var(--dsw-focus-ring-width,2px)_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:1px]',
    label: 'min-w-0 text-secondary',
  },
  variants: {
    size: {
      md: { base: 'text-[14px] leading-[20px]', input: 'w-[16px] h-[16px]' },
      xs: { base: 'text-[12px] leading-[16px]', input: 'w-[12px] h-[12px]' },
    },
  },
  defaultVariants: { size: 'md' },
})

export function Checkbox({ checked, disabled, onChange, children, 'aria-label': ariaLabel, title, size }: CheckboxProps): ReactElement {
  const styles = checkbox({ size })
  return (
    <label className={styles.base()} title={title}>
      <input
        className={styles.input()}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={event => onChange(event.target.checked)}
      />
      {children === undefined ? null : <span className={styles.label()}>{children}</span>}
    </label>
  )
}
