import type { Menu, Modal, Toast } from 'dsh-tauri-ui/client'
import type { ComponentProps, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { PrimitiveButton } from './scheduler-client.test.ui'

export { PrimitiveButton }

export function AmbientMenu({ open, anchor, children, onClose, portal }: ComponentProps<typeof Menu>): ReactElement {
  const menu = open
    ? (
        <div
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape')
              onClose()
          }}
        >
          {children}
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

export function AmbientModal({ open, title, description, closeLabel, children, footer, onClose }: ComponentProps<typeof Modal>): ReactElement | null {
  return open
    ? createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onKeyDown={(event) => {
            if (event.key === 'Escape')
              onClose()
          }}
        >
          <h2>{title}</h2>
          <p>{description}</p>
          <button type="button" aria-label={closeLabel} onClick={onClose} />
          {children}
          {footer}
        </div>,
        document.body,
      )
    : null
}

export function AmbientToast({ text, tone, onDone }: ComponentProps<typeof Toast>): ReactElement {
  return createPortal(
    <div role="alert" data-tone={tone}>
      {text}
      <button type="button" aria-label="complete-banner" onClick={onDone} />
    </div>,
    document.body,
  )
}
