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
  icon?: ReactNode
}

export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange' | 'value'> {
  options: readonly SelectOption[]
  value: string
  onChange: (next: string) => void
  variant?: ChipVariant
  icon?: ReactNode
  chevron?: ReactNode
  label?: string
}

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
