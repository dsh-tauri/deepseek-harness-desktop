import type { ComposerIconState, ComposerSessionEventEntry, ComposerSessionSnapshot } from './composer-resume.types'
import { isContentRiskFailure, lastTurnEndReason } from '../../shared/content-risk'

const PLAY_FILL_PATH = 'M14.642 6.285c1.294.777 1.294 2.653 0 3.43l-9.113 5.468c-1.333.8-3.028-.16-3.029-1.715V2.532C2.5.978 4.196.018 5.53.818z'

const COMPOSER_PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'

const RESUMABLE_TURN_END_KINDS = ['aborted', 'error', 'interrupted']

export function primaryButtonOf(card: Element): HTMLButtonElement | null {
  const buttons = card.querySelectorAll('button')
  const last = buttons.item(buttons.length - 1)
  return last instanceof HTMLButtonElement ? last : null
}

export function isComposerEmpty(card: Element): boolean {
  return card.querySelector(COMPOSER_PLACEHOLDER_SELECTOR) !== null
}

export function lastTurnEndKind(entries: readonly ComposerSessionEventEntry[] | undefined): string | undefined {
  const kind = lastTurnEndReason(entries)?.kind
  return typeof kind === 'string' ? kind : undefined
}

export function readIconPath(button: HTMLButtonElement): string | null {
  return button.querySelector('svg path')?.getAttribute('d') ?? null
}

export function isResumableTurnEnd(kind: string | undefined): boolean {
  return kind !== undefined && RESUMABLE_TURN_END_KINDS.includes(kind)
}

/**
 * 最新一轮是否因内容审核被拒。命中时主按钮必须提供「安全恢复」而不是普通继续——
 * 普通继续会把被拒上下文原样重放，同一会话将持续 400。
 */
export function isContentRiskTurnEnd(entries: readonly ComposerSessionEventEntry[] | undefined): boolean {
  if (entries === undefined)
    return false
  return isContentRiskFailure(lastTurnEndReason(entries)?.error)
}

export function shouldOfferResume(input: {
  session?: ComposerSessionSnapshot
  entries?: readonly ComposerSessionEventEntry[]
}): boolean {
  const session = input.session
  if (session === undefined || session.running === true || session.removed === true)
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
