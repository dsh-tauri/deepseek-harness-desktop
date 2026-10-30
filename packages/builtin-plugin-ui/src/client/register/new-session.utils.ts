import { NEW_SESSION_LABELS, UNGROUPED_ROW_KEY } from '../constants'

export function isNewSessionLabel(label: string | null): boolean {
  return label !== null && (NEW_SESSION_LABELS as readonly string[]).includes(label)
}

export function newSessionButtonFrom(target: unknown): Element | null {
  if (!(target instanceof Element))
    return null
  const button = target.closest('button[aria-label]')
  return button !== null && isNewSessionLabel(button.getAttribute('aria-label')) ? button : null
}

export function ungroupedCreateButtonFrom(target: unknown): Element | null {
  if (!(target instanceof Element))
    return null
  const button = target.closest('button[aria-label]')
  if (button === null)
    return null
  const row = button.closest('[data-row-key]')
  return row?.getAttribute('data-row-key') === UNGROUPED_ROW_KEY ? button : null
}
