import type { CSSProperties, ReactNode, RefObject } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { tv, useEventListener } from 'dsh-tauri/client'
import { useRef } from 'react'
import { createPortal } from 'react-dom'

export const pickerTrigger = tv({
  base: 'inline-flex flex-[0_1_auto] min-w-0 items-center justify-end gap-[6px] px-[8px] py-[5px] border-none rounded-[18px] bg-transparent text-primary [font-family:inherit] text-[14px] leading-[1.6] text-right tabular-nums cursor-pointer transition-colors duration-150 hover:not-disabled:bg-hover disabled:text-tertiary disabled:cursor-default focus-visible:[outline:2px_solid_var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))] focus-visible:[outline-offset:1px]',
})

const panel = tv({
  base: 'fixed box-border z-[1100] flex border-0 rounded-[16px] bg-[var(--dsw-specific-menu)] [backdrop-filter:var(--dsw-menu-backdrop-filter)] [--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)] shadow-[var(--dsw-elevation-prominent)] [--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)] [--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)]',
})

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

interface PickerPopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  label: string
  className?: string
  onClose: () => void
  children: ReactNode
}

export function PickerPopover({ open, anchorRef, label, className, onClose, children }: PickerPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef(typeof document === 'undefined' ? null : document)
  useDismissOnOutsidePointer(anchorRef, open, onClose, panelRef)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 4, margin: 12 })
  useEventListener(documentRef, 'keydown', (event) => {
    if (!open || event.key !== 'Escape' || (!anchorRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)))
      return
    event.preventDefault()
    event.stopPropagation()
    onClose()
    anchorRef.current?.focus()
  }, { capture: true })
  if (!open)
    return null
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className={panel({ className })}
      style={position ?? MEASURE_STYLE}
      onClick={event => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
