import type { ReactNode } from 'react'
import { createElement } from 'react'

type Props = Record<string, unknown> & { children?: ReactNode }

function Button({ variant: _variant, size: _size, onPress, onClick, children, ...rest }: Props & { onPress?: () => void, onClick?: () => void }): ReactNode {
  return createElement('button', { type: 'button', ...rest, onClick: onPress ?? onClick }, children as never)
}

function Pill({ active: _active, children, ...rest }: Props): ReactNode {
  return createElement('button', { type: 'button', ...rest }, children as never)
}

function Input(props: Props): ReactNode {
  return createElement('input', props)
}

function Modal({ open, onClose: _onClose, closeLabel: _closeLabel, title, description, footer, children }: Props): ReactNode {
  if (open === false)
    return null
  return createElement(
    'div',
    { 'role': 'dialog', 'aria-label': title },
    createElement('p', null, title as never),
    description === undefined ? null : createElement('p', null, description as never),
    children as never,
    footer as never,
  )
}

function StateDot(): ReactNode {
  return null
}

function Field({ label, children, ...rest }: Props): ReactNode {
  return createElement('div', rest, createElement('span', null, label as never), children as never)
}

function Select({ options, value, onChange, label, ...rest }: Props & {
  options: Array<{ value: string, label: string }>
  value: string
  onChange: (next: string) => void
  label?: string
}): ReactNode {
  return createElement(
    'select',
    {
      'aria-label': label,
      'value': value,
      'onChange': (event: { target: { value: string } }) => onChange(event.target.value),
      ...rest,
    },
    options.map(option => createElement('option', { key: option.value, value: option.value }, option.label)),
  )
}

function Globe(): ReactNode {
  return null
}

function Icon(): ReactNode {
  return null
}

function SegmentedControl({ options, value, onChange }: Props & {
  options: Array<{ value: string, label: string }>
  value: string
  onChange: (next: string) => void
}): ReactNode {
  return createElement(
    'div',
    { role: 'tablist' },
    options.map(option => createElement(
      'button',
      {
        'key': option.value,
        'type': 'button',
        'role': 'tab',
        'aria-selected': option.value === value,
        'onClick': () => onChange(option.value),
      },
      option.label,
    )),
  )
}

function Switch({ checked, onChange, label, disabled, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string | undefined
  className?: string | undefined
}): ReactNode {
  return createElement('button', {
    'type': 'button',
    'role': 'switch',
    'aria-checked': checked,
    'aria-label': label,
    disabled,
    title,
    className,
    'onClick': () => onChange(!checked),
  })
}

export const uiMock = {
  Button,
  Field,
  Globe,
  Icon,
  Input,
  Modal,
  Pill,
  SegmentedControl,
  Select,
  StateDot,
  Switch,
}
