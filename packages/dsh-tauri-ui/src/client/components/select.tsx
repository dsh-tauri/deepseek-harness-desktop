// 引用源 本仓自建（组合官方 primitives 的 `Menu` 与本地 `Chip`；无上游对应）· 版本 不适用 · hash 不适用
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import type { ChipVariant } from './chip'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useWatchImmediate } from 'dsh-tauri/client'
import { useState } from 'react'
import { Chip } from './chip'
import { Icon } from './icon'
import { ChevronDown } from './icons'

export interface SelectOption {
  value: string
  label: string
  /** 逐项图标（菜单行与触发器共用同一套 chips 排版）。 */
  icon?: ReactNode
}

export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange' | 'value'> {
  options: readonly SelectOption[]
  value: string
  onChange: (next: string) => void
  /** 触发器外观：复用 chip 的三档（见 `chip.tsx`），默认设置行那档。 */
  variant?: ChipVariant
  icon?: ReactNode
  chevron?: ReactNode
  /** 无可见文案时的无障碍名（触发器内容取选中项 label）。 */
  label?: string
}

/** 下拉选择：`Chip` 触发器 + 官方 portal `Menu`，选中态与展开态由组件自管。 */
export function Select({
  options,
  value,
  onChange,
  variant = 'selector',
  icon,
  chevron,
  label,
  onClick,
  disabled,
  ...rest
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  useWatchImmediate(disabled, () => {
    if (disabled)
      setOpen(false)
  })
  const selected = options.find(option => option.value === value)
  return (
    <Menu
      open={open && !disabled}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        if (disabled)
          return
        setOpen(false)
        onChange(id)
      }}
      items={options.map(option => ({ id: option.value, label: option.label, icon: option.icon }))}
      selectedId={value}
      portal
      align="end"
      anchor={(
        <Chip
          variant={variant}
          disabled={disabled}
          open={open && !disabled}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          icon={icon}
          chevron={chevron ?? <Icon as={ChevronDown} />}
          onClick={(event) => {
            onClick?.(event)
            setOpen(state => !state)
          }}
          {...rest}
        >
          {selected?.label ?? value}
        </Chip>
      )}
    />
  )
}
