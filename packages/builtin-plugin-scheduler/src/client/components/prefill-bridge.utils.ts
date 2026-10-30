export function applyPrefillToComposer(text: string): boolean {
  const seat = document.querySelector('[data-composer-seat] textarea')
  if (!(seat instanceof HTMLTextAreaElement))
    return false
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  descriptor?.set?.call(seat, text)
  seat.dispatchEvent(new InputEvent('input', { bubbles: true }))
  seat.focus()
  return true
}
