import type { ComposerIconState, ComposerRefusal, ComposerSessionEventEntry, ComposerSessionSnapshot } from './composer-resume.types'

const PLAY_FILL_PATH = 'M14.642 6.285c1.294.777 1.294 2.653 0 3.43l-9.113 5.468c-1.333.8-3.028-.16-3.029-1.715V2.532C2.5.978 4.196.018 5.53.818z'

const COMPOSER_PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'

const RESUMABLE_TURN_END_KINDS = ['aborted', 'error', 'interrupted']

const CONTENT_RISK_PATTERN = /content exists risk/i

export function primaryButtonOf(card: Element): HTMLButtonElement | null {
  const buttons = card.querySelectorAll('button')
  const last = buttons.item(buttons.length - 1)
  return last instanceof HTMLButtonElement ? last : null
}

export function isComposerEmpty(card: Element): boolean {
  return card.querySelector(COMPOSER_PLACEHOLDER_SELECTOR) !== null
}

export function lastTurnEndKind(entries: readonly ComposerSessionEventEntry[] | undefined): string | undefined {
  if (entries === undefined)
    return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event
    if (event?.type !== 'turn/end')
      continue
    return event.data?.reason?.kind
  }
  return undefined
}

export function refusalFromTurnEnd(entries: readonly ComposerSessionEventEntry[] | undefined): ComposerRefusal | undefined {
  if (entries === undefined)
    return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event
    if (event?.type !== 'turn/end')
      continue
    const error = event.data?.reason?.error
    const message = error?.message
    if (error?.code !== 'INVALID_REQUEST' || error.status !== 400)
      return undefined
    if (typeof message !== 'string' || !CONTENT_RISK_PATTERN.test(message))
      return undefined
    return { message, code: error.code, status: error.status }
  }
  return undefined
}

export function safeResumeBoundary(entries: readonly ComposerSessionEventEntry[] | undefined): number | undefined {
  if (entries === undefined)
    return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed')
      continue
    const seq = event.seq
    return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq : undefined
  }
  return undefined
}

export function readIconPath(button: HTMLButtonElement): string | null {
  return button.querySelector('svg path')?.getAttribute('d') ?? null
}

export function isResumableTurnEnd(kind: string | undefined): boolean {
  return kind !== undefined && RESUMABLE_TURN_END_KINDS.includes(kind)
}

export function shouldOfferResume(input: {
  session?: ComposerSessionSnapshot
  entries?: readonly ComposerSessionEventEntry[]
}): boolean {
  const session = input.session
  if (session === undefined || session.running === true || session.removed === true)
    return false
  if (refusalFromTurnEnd(input.entries) !== undefined)
    return false
  return isResumableTurnEnd(lastTurnEndKind(input.entries))
}

export function restoreDisabled(composerEmpty: boolean, running: boolean, hasSubagent: boolean): boolean {
  return composerEmpty && !(running && !hasSubagent)
}

export function paintResumeIcon(button: HTMLButtonElement, label: string): void {
  const path = button.querySelector('svg path')
  const svg = button.querySelector('svg')
  if (path !== null && path.getAttribute('d') !== PLAY_FILL_PATH)
    path.setAttribute('d', PLAY_FILL_PATH)
  if (button.disabled)
    button.disabled = false
  if (button.getAttribute('aria-label') !== label)
    button.setAttribute('aria-label', label)

  if (svg)
    svg.style.width = '14px'
}

export function restorePrimaryIcon(
  button: HTMLButtonElement,
  state: ComposerIconState,
  options: { label: string, disabled: boolean },
): void {
  const path = button.querySelector('svg path')
  const svg = button.querySelector('svg')
  if (state.path !== null && path !== null && path.getAttribute('d') === PLAY_FILL_PATH)
    path.setAttribute('d', state.path)
  if (button.getAttribute('aria-label') === options.label) {
    if (state.ariaLabel === null)
      button.removeAttribute('aria-label')
    else
      button.setAttribute('aria-label', state.ariaLabel)
  }
  if (options.disabled)
    button.disabled = true
  if (svg)
    svg.style.width = '16px'
}
