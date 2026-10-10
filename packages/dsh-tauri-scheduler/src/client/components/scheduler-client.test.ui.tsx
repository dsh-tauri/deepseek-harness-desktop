import type { MenuEntry } from 'dsh-tauri-ui/client'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function PrimitiveButton({ variant: _variant, size: _size, icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string, size?: string, icon?: ReactNode }): ReactElement {
  return (
    <button type="button" {...props}>
      {icon}
      {children}
    </button>
  )
}

export function PrimitiveInput(props: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input {...props} />
}

export function PrimitiveMenu({ open, anchor, items = [], onSelect, portal, children, onClose }: { open: boolean, anchor: ReactNode, items?: readonly MenuEntry[], onSelect?: (id: string) => void, portal?: boolean, children?: ReactNode, onClose?: () => void }): ReactElement {
  const menu = open
    ? (
        <div
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape')
              onClose?.()
          }}
        >
          {children}
          {items.map(item => 'type' in item
            ? item.type === 'label' ? <span key={item.id}>{item.text}</span> : <hr key={item.id} />
            : <button type="button" role="menuitem" key={item.id} disabled={item.disabled} onClick={() => onSelect?.(item.id)}>{item.label}</button>)}
        </div>
      )
    : null
  return (
    <>
      {anchor}
      {portal && menu ? createPortal(menu, document.body) : menu}
    </>
  )
}

export async function schedulerClientUi() {
  const [action, button, card, checkbox, chip, icon, icons, segmented, select, tag, text, textarea, theme] = await Promise.all([
    import('../../../../dsh-tauri-ui/src/client/components/action'),
    import('../../../../dsh-tauri-ui/src/client/components/button'),
    import('../../../../dsh-tauri-ui/src/client/components/card'),
    import('../../../../dsh-tauri-ui/src/client/components/checkbox'),
    import('../../../../dsh-tauri-ui/src/client/components/chip'),
    import('../../../../dsh-tauri-ui/src/client/components/icon'),
    import('../../../../dsh-tauri-ui/src/client/components/icons'),
    import('../../../../dsh-tauri-ui/src/client/components/segmented-control'),
    import('../../../../dsh-tauri-ui/src/client/components/select'),
    import('../../../../dsh-tauri-ui/src/client/components/tag'),
    import('../../../../dsh-tauri-ui/src/client/components/text'),
    import('../../../../dsh-tauri-ui/src/client/components/textarea'),
    import('../../../../dsh-tauri-ui/src/client/constants/theme'),
  ])
  return {
    ...icons,
    Action: action.Action,
    Button: button.Button,
    Card: card.Card,
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Checkbox: checkbox.Checkbox,
    Chip: chip.Chip,
    Icon: icon.Icon,
    SegmentedControl: segmented.SegmentedControl,
    Select: select.Select,
    Tag: tag.Tag,
    Text: text.Text,
    Textarea: textarea.Textarea,
    Input: PrimitiveInput,
    Menu: PrimitiveMenu,
    Toast: () => null,
    DatePicker: ({ value, label, onChange }: { value: string, label: string, onChange: (value: string) => void }) => <input type="date" aria-label={label} value={value} onChange={event => onChange(event.target.value)} />,
    TimePicker: ({ value, label, onChange, seconds }: { value: string, label: string, onChange: (value: string) => void, seconds?: boolean }) => <input type="time" step={seconds === false ? 60 : 1} aria-label={label} value={value} onChange={event => onChange(event.target.value)} />,
    styles: theme.styles,
  }
}
